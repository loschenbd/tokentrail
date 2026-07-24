// Tokentrail — native macOS menu-bar widget (prototype).
//
// A thin SwiftUI client over the local dashboard daemon. Polls
// `GET /api/today` on 127.0.0.1:4920 every 60s and renders the same
// numbers + stacked-area trend the SwiftBar plugin does — but natively,
// with Swift Charts, in one persistent ~20 MB process instead of
// spawning an 85 MB Node process every minute.
//
// Two entry paths (see `Main.main`):
//   (default)       run as a MenuBarExtra agent
//   --render-png P  fetch once, render the panel to PNG at path P, exit
//                   (headless verification via ImageRenderer)

import SwiftUI
import Charts
import AppKit

// MARK: - Wire model (matches /api/today exactly)

struct TodayResponse: Decodable {
    let todayUsd: Double
    let topProjects: [Project]
    let anomalyCount: Int
    let topAnomaly: Anomaly?
    let lastEventAt: String?
    let menubar: Menubar
    let sourcesToday: SourcesResponse?
    let sources30d: SourcesResponse?
}

struct SourceCost: Decodable, Identifiable {
    let key: String
    let label: String
    let usd: Double
    let extra: Extra?
    struct Extra: Decodable { let aiLines: Int? }
    var id: String { key }
}
struct SourcesResponse: Decodable {
    let days: Int
    let totalUsd: Double
    let sources: [SourceCost]
}

struct Project: Decodable, Identifiable {
    let key: String
    let name: String
    let usd: Double
    let href: String
    let features: [Feature]
    var id: String { key }
}

struct Feature: Decodable, Identifiable {
    let key: String
    let name: String
    let usd: Double
    let href: String
    var id: String { key }
}

struct Anomaly: Decodable {
    let amount: Double
    let date: String
    let reason: String
}

struct Menubar: Decodable {
    let sparkline: [Double]
    let last7Usd: Double
    let last30Usd: Double
    // Infinity is serialized as null on the wire (JSON has no Infinity),
    // so this is optional: nil == "first day" (yesterday was $0).
    let deltaVsYesterday: Double?
    let yesterdayUsd: Double
    let trend: Trend
}

struct Trend: Decodable {
    let days: [TrendDay]
    let projects: [TrendProject]
    let others: [TrendOther]?
}

struct TrendDay: Decodable {
    let date: String
    let bands: [String: Double]
}

struct TrendProject: Decodable {
    let key: String
    let name: String
    let color: String
    let stackPosition: Int
}

struct TrendOther: Decodable {
    let key: String
    let name: String
    let totalUsd: Double
    let color: String
}

// MARK: - Networking

enum Api {
    static let base = ProcessInfo.processInfo.environment["TT_DASHBOARD_URL"]
        ?? "http://127.0.0.1:4920"
    static var todayURL: URL { URL(string: "\(base)/api/today")! }

    // The dashboard's per-project page. The key holds ":" and "/"
    // (e.g. "repo:loschenbd/tokentrail"), which must be percent-encoded —
    // the route 404s on the raw key.
    static func projectURL(_ key: String) -> URL {
        let allowed = CharacterSet(charactersIn: "-._~").union(.alphanumerics)
        let enc = key.addingPercentEncoding(withAllowedCharacters: allowed) ?? key
        return URL(string: "\(base)/project/\(enc)") ?? URL(string: base)!
    }

    static func fetch() async throws -> TodayResponse {
        var req = URLRequest(url: todayURL)
        req.timeoutInterval = 2
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(TodayResponse.self, from: data)
    }

    // Blocking fetch for the headless --render-png path.
    static func fetchSync() -> TodayResponse? {
        let sem = DispatchSemaphore(value: 0)
        var out: TodayResponse?
        var req = URLRequest(url: todayURL)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let data, let decoded = try? JSONDecoder().decode(TodayResponse.self, from: data) {
                out = decoded
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 4)
        return out
    }
}

// MARK: - Store

@MainActor
final class Store: ObservableObject {
    @Published var today: TodayResponse?
    @Published var error: String?
    private var timer: Timer?

    init(preloaded: TodayResponse? = nil) {
        self.today = preloaded
    }

    func start() {
        Task { await refresh() }
        // Poll every 60s — same cadence as the SwiftBar plugin, but this is
        // one URLSession call in a live process, not a fresh Node spawn.
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
    }

    func refresh() async {
        do {
            today = try await Api.fetch()
            error = nil
        } catch {
            self.error = "dashboard not running"
        }
    }

    // Menu-bar title: "~$89.22". Tilde carries "estimated".
    var menuTitle: String {
        guard let t = today else { return "$—" }
        return "~" + Fmt.usd(t.todayUsd)
    }

    // A session wrote events in the last 5 minutes → live dot.
    var isLive: Bool {
        guard let iso = today?.lastEventAt,
              let d = Fmt.isoDate(iso) else { return false }
        return Date().timeIntervalSince(d) < 5 * 60
    }

    // Hot day: today is an unusual burn — ≥2× the median non-zero prior day
    // in the sparkline window, past a $25 floor so a quiet morning doesn't
    // flag against a tiny median. Mirrors the SwiftBar plugin's isHotDay.
    var isHot: Bool {
        guard let t = today, t.todayUsd >= 25 else { return false }
        let prior = t.menubar.sparkline.dropLast().filter { $0 > 0 }.sorted()
        guard prior.count >= 3 else { return false }
        let median = prior[prior.count / 2]
        return t.todayUsd >= 2 * median
    }
}

// MARK: - Formatting

enum Fmt {
    static func usd(_ n: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = 2
        f.minimumFractionDigits = 2
        return f.string(from: NSNumber(value: n)) ?? "$\(n)"
    }
    static func usd0(_ n: Double) -> String {
        "$" + Int(n.rounded()).formatted()
    }
    static func delta(_ d: Double?) -> (text: String, up: Bool)? {
        guard let d else { return ("first day", true) }
        if d == 0 { return ("—", true) }
        let up = d > 0
        let abs = Swift.abs(d)
        if up && abs >= 300 { return ("▲ \(String(format: "%.1f", 1 + abs/100))x", true) }
        return ((up ? "▲ " : "▼ ") + "\(Int(abs))%", up)
    }
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static func isoDate(_ s: String) -> Date? {
        iso.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone.current
        return f
    }()
    static func dayDate(_ s: String) -> Date? { day.date(from: s) }
    private static let monthDayFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        f.timeZone = TimeZone.current
        return f
    }()
    // "2026-07-11" → "Jul 11" (falls back to the raw string if unparseable).
    static func monthDay(_ s: String) -> String {
        guard let d = dayDate(s) else { return s }
        return monthDayFmt.string(from: d)
    }
    // Strip the leading "`hash…` · " fragment and backticks from an anomaly
    // reason, leaving the human sentence ("$839 in one session.").
    static func anomalyReason(_ raw: String) -> String {
        let noTicks = raw.replacingOccurrences(of: "`", with: "")
        let parts = noTicks.components(separatedBy: " · ")
        if parts.count > 1, parts[0].contains("…") {
            return parts.dropFirst().joined(separator: " · ")
        }
        return noTicks
    }
}

extension Color {
    init(hex: String) {
        let h = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        var v: UInt64 = 0
        Scanner(string: h).scanHexInt64(&v)
        self = Color(
            red: Double((v >> 16) & 0xff) / 255,
            green: Double((v >> 8) & 0xff) / 255,
            blue: Double(v & 0xff) / 255
        )
    }
}

// A subtle rounded highlight on hover, marking a row as clickable. The
// negative horizontal padding lets the fill bleed slightly into the panel
// margin while keeping the row's text aligned with non-interactive rows.
struct HoverHighlight: ViewModifier {
    @State private var hovering = false
    func body(content: Content) -> some View {
        content
            .padding(.vertical, 4)
            .padding(.horizontal, 6)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(hovering ? Color.primary.opacity(0.08) : Color.clear)
            )
            .padding(.horizontal, -6)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
    }
}

extension View {
    func hoverHighlight() -> some View { modifier(HoverHighlight()) }
}

// MARK: - Chart

private struct StackPoint: Identifiable {
    let id = UUID()
    let date: Date
    let project: String
    let usd: Double
}

struct TrendChart: View {
    let trend: Trend
    // The focused project — shared with the breakdown list, so hovering a
    // row there dims the chart too. nil = nothing focused (all bands lit).
    @Binding var focused: String?
    // Cursor-local detail for the tooltip (which day + value). Only set while
    // the pointer is over the chart itself.
    @State private var hover: Hover?

    struct Hover: Equatable {
        let date: Date
        let project: String
        let usd: Double
    }

    // Chart-hover wins (it has a specific day); otherwise the list's focus.
    private var activeProject: String? { hover?.project ?? focused }

    // Projects ordered bottom→top by stackPosition; __other__ folded to gray.
    private var ordered: [TrendProject] {
        trend.projects.sorted { $0.stackPosition < $1.stackPosition }
    }
    private var domain: [String] { ordered.map(\.name) }
    private var range: [Color] {
        ordered.map { $0.key == "__other__" ? Color.gray.opacity(0.5) : Color(hex: $0.color) }
    }
    private var keyToName: [String: String] {
        Dictionary(uniqueKeysWithValues: ordered.map { ($0.key, $0.name) })
    }
    private var nameToColor: [String: Color] {
        Dictionary(uniqueKeysWithValues: ordered.map { p in
            (p.name, p.key == "__other__" ? Color.gray.opacity(0.5) : Color(hex: p.color))
        })
    }
    // Parsed (date, bands) per day — reused for the marks and hit-testing.
    private var byDay: [(date: Date, bands: [String: Double])] {
        trend.days.compactMap { d in
            guard let date = Fmt.dayDate(d.date) else { return nil }
            return (date, d.bands)
        }
    }
    private var points: [StackPoint] {
        var out: [StackPoint] = []
        for day in byDay {
            for p in ordered {
                out.append(StackPoint(date: day.date,
                                      project: keyToName[p.key] ?? p.key,
                                      usd: day.bands[p.key] ?? 0))
            }
        }
        return out
    }
    // The focused project's own daily values (independent of the stack), so
    // it can be redrawn from the zero baseline while hovered.
    private var focusedPoints: [StackPoint] {
        guard let active = activeProject,
              let proj = ordered.first(where: { $0.name == active }) else { return [] }
        return byDay.map {
            StackPoint(date: $0.date, project: active, usd: $0.bands[proj.key] ?? 0)
        }
    }

    var body: some View {
        Chart {
            // The stacked backdrop. Full color normally; dimmed to a faint
            // ghost when a project is focused so the overlay below reads clearly.
            ForEach(points) { pt in
                AreaMark(
                    x: .value("Date", pt.date),
                    y: .value("USD", pt.usd),
                    stacking: .standard
                )
                .foregroundStyle(by: .value("Project", pt.project))
                .interpolationMethod(.monotone)
                .opacity(activeProject == nil ? 1 : 0.12)
            }
            // The focused project, redrawn un-stacked from the zero baseline in
            // full color (+ a crisp top line) — so even small days stay visible
            // instead of becoming a sliver floating on the stack.
            if let active = activeProject {
                ForEach(focusedPoints) { pt in
                    AreaMark(
                        x: .value("Date", pt.date),
                        y: .value("USD", pt.usd),
                        stacking: .unstacked
                    )
                    .foregroundStyle((nameToColor[active] ?? .gray).opacity(0.85))
                    .interpolationMethod(.monotone)
                }
                ForEach(focusedPoints) { pt in
                    LineMark(x: .value("Date", pt.date), y: .value("USD", pt.usd))
                        .foregroundStyle(nameToColor[active] ?? .gray)
                        .interpolationMethod(.monotone)
                        .lineStyle(StrokeStyle(lineWidth: 1.5))
                }
            }
            if let h = hover {
                RuleMark(x: .value("Date", h.date))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .foregroundStyle(Color.secondary.opacity(0.5))
                    .annotation(position: .top, spacing: 2,
                                overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        tooltip(h)
                    }
            }
        }
        .chartForegroundStyleScale(domain: domain, range: range)
        .chartLegend(.hidden)
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, count: 7)) { _ in
                AxisGridLine().foregroundStyle(.quaternary)
                AxisValueLabel(format: .dateTime.month(.abbreviated).day(),
                               collisionResolution: .greedy)
                    .font(.system(size: 9))
            }
        }
        .chartYAxis {
            AxisMarks(position: .trailing) { value in
                AxisGridLine().foregroundStyle(.quaternary)
                AxisValueLabel {
                    if let d = value.as(Double.self) {
                        Text(Fmt.usd0(d)).font(.system(size: 9))
                    }
                }
            }
        }
        .frame(height: 96)
        .chartOverlay { proxy in
            GeometryReader { geo in
                Rectangle().fill(Color.clear).contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let loc): updateHover(loc, proxy: proxy, geo: geo)
                        case .ended: hover = nil; focused = nil
                        }
                    }
            }
        }
    }

    private func tooltip(_ h: Hover) -> some View {
        HStack(spacing: 5) {
            Circle().fill(nameToColor[h.project] ?? .gray).frame(width: 7, height: 7)
            Text(h.project).font(.system(size: 11, weight: .medium))
            Text(Fmt.usd(h.usd)).font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
            Text(Fmt.monthDay(dayString(h.date))).font(.system(size: 10))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 7).padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 5).fill(.regularMaterial))
        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.secondary.opacity(0.2)))
        .fixedSize()
    }

    // Map the cursor to the stacked band beneath it: convert x→nearest day,
    // y→a dollar level, then walk the day's bands bottom→top to find which
    // one's cumulative range contains that level.
    private func updateHover(_ loc: CGPoint, proxy: ChartProxy, geo: GeometryProxy) {
        guard let plotFrame = proxy.plotFrame else { return }
        let frame = geo[plotFrame]
        let x = loc.x - frame.origin.x
        let y = loc.y - frame.origin.y
        guard x >= 0, x <= frame.width, y >= 0, y <= frame.height,
              let rawDate: Date = proxy.value(atX: x),
              let usdAtY: Double = proxy.value(atY: y) else { hover = nil; focused = nil; return }
        guard let day = byDay.min(by: {
            abs($0.date.timeIntervalSince(rawDate)) < abs($1.date.timeIntervalSince(rawDate))
        }) else { hover = nil; focused = nil; return }
        var cum = 0.0
        for p in ordered {
            let v = day.bands[p.key] ?? 0
            if v > 0, usdAtY >= cum, usdAtY < cum + v {
                let name = keyToName[p.key] ?? p.key
                let next = Hover(date: day.date, project: name, usd: v)
                if hover != next { hover = next }
                if focused != name { focused = name }
                return
            }
            cum += v
        }
        hover = nil; focused = nil  // above the stacked total → nothing to focus
    }

    private static let dayFmt: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = .current; return f
    }()
    private func dayString(_ d: Date) -> String { Self.dayFmt.string(from: d) }
}

// MARK: - Panel

struct PanelView: View {
    @ObservedObject var store: Store
    // Which project is focused (dimming every other chart band). Driven by
    // hovering either the chart or a row in the breakdown list. TT_FOCUS seeds
    // it for the headless preview, which can't hover.
    @State private var focused: String? = ProcessInfo.processInfo.environment["TT_FOCUS"]
    // Which source is selected in the picker. TT_SOURCE seeds it for the
    // headless preview (mirrors TT_FOCUS above), since the picker can't be
    // clicked in a headless --render-png run.
    @State private var sourceTab: SourceTab =
        SourceTab(rawValue: ProcessInfo.processInfo.environment["TT_SOURCE"] ?? "") ?? .all

    enum SourceTab: String, CaseIterable { case all = "All", claude = "Claude", cursor = "Cursor" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let t = store.today {
                if hasCursor(t) {
                    Picker("", selection: $sourceTab) {
                        ForEach(SourceTab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
                if sourceTab == .cursor {
                    cursorView(t)
                } else {
                    header(t)
                    Divider()
                    statBlock(t)
                    if sourceTab == .all { sourceSplit(t) }
                    if t.menubar.trend.days.count >= 2 {
                        TrendChart(trend: t.menubar.trend, focused: $focused)
                        BreakdownView(trend: t.menubar.trend, focused: $focused)
                    }
                    Divider(); worthALook(t)
                    if !t.topProjects.isEmpty { Divider(); projects(t) }
                }
                Divider()
                actions()
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Tokentrail").font(.headline)
                    Text(store.error ?? "loading…")
                        .font(.callout).foregroundStyle(.secondary)
                }
                actions()
            }
        }
        .padding(14)
        .frame(width: 320)
    }

    private func hasCursor(_ t: TodayResponse) -> Bool {
        (t.sourcesToday?.sources.contains { $0.key == "cursor" } ?? false)
        || (t.sources30d?.sources.contains { $0.key == "cursor" } ?? false)
    }

    @ViewBuilder private func sourceSplit(_ t: TodayResponse) -> some View {
        if let s = t.sources30d, s.sources.count > 1 {
            HStack(spacing: 8) {
                Text("30d by source").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(s.sources.map { "\($0.label) \(Fmt.usd($0.usd))" }.joined(separator: " · "))
                    .font(.caption)
            }
        }
    }

    @ViewBuilder private func cursorView(_ t: TodayResponse) -> some View {
        let today = t.sourcesToday?.sources.first { $0.key == "cursor" }
        let d30 = t.sources30d?.sources.first { $0.key == "cursor" }
        VStack(alignment: .leading, spacing: 6) {
            Text("Cursor").font(.headline)
            Text("\(Fmt.usd(today?.usd ?? 0)) today · \(Fmt.usd(d30?.usd ?? 0)) this cycle (est.)")
                .font(.callout)
            if let lines = d30?.extra?.aiLines, lines > 0 {
                Text("\(lines) AI-authored lines (all-time)")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func header(_ t: TodayResponse) -> some View {
        // Projects that logged spend today — the last trend day is today.
        let activeToday = t.menubar.trend.days.last?.bands.values.filter { $0 > 0 }.count ?? 0
        return HStack(spacing: 6) {
            if store.isLive {
                Circle().fill(Color(hex: "#5f6f5e")).frame(width: 7, height: 7)
            }
            Text("~" + Fmt.usd(t.todayUsd))
                .font(.system(size: 20, weight: .semibold, design: .rounded))
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                if let iso = t.lastEventAt, let d = Fmt.isoDate(iso) {
                    Text(agoText(d)).font(.caption).foregroundStyle(.secondary)
                }
                if activeToday > 0 {
                    Text("\(activeToday) active today")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
    }

    private func statRow(_ label: String, _ value: String, bold: Bool = false, trailing: AnyView? = nil) -> some View {
        HStack {
            Text(label).font(bold ? .system(size: 13, weight: .semibold) : .system(size: 12))
                .foregroundStyle(bold ? .primary : .secondary)
            Spacer()
            if let trailing { trailing }
            Text(value).font(.system(size: bold ? 13 : 12, weight: bold ? .semibold : .regular, design: .monospaced))
        }
    }

    private func statBlock(_ t: TodayResponse) -> some View {
        VStack(spacing: 5) {
            let delta = Fmt.delta(t.menubar.deltaVsYesterday)
            statRow("Today", Fmt.usd(t.todayUsd), bold: true, trailing: delta.map { d in
                AnyView(Text(d.text).font(.system(size: 11, weight: .medium))
                    .foregroundStyle(d.up ? Color(hex: "#b88a3a") : Color(hex: "#5f6f5e")))
            })
            statRow("Yesterday", Fmt.usd(t.menubar.yesterdayUsd))
            statRow("Last 7d", Fmt.usd(t.menubar.last7Usd))
            statRow("Last 30d", Fmt.usd(t.menubar.last30Usd))
        }
    }

    private func worthALook(_ t: TodayResponse) -> some View {
        // The whole callout links to the dashboard's anomaly page, so a
        // click goes straight to "what needs a look".
        Link(destination: URL(string: Api.base + "/worth-a-look")!) {
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Image(systemName: t.anomalyCount > 0 ? "exclamationmark.triangle.fill" : "checkmark.circle")
                        .foregroundStyle(t.anomalyCount > 0 ? Color(hex: "#b88a3a") : .secondary)
                        .font(.system(size: 12))
                    Text("Worth a look").font(.system(size: 13, weight: t.anomalyCount > 0 ? .semibold : .regular))
                    Spacer()
                    if let a = t.topAnomaly {
                        Text(Fmt.usd0(a.amount) + (t.anomalyCount > 1 ? " +\(t.anomalyCount - 1)" : ""))
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                    } else {
                        Text("—").font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)
                    }
                }
                // The largest anomaly's date + reason, so the dollar figure has
                // context instead of being a bare number.
                if let a = t.topAnomaly {
                    Text("\(Fmt.monthDay(a.date)) · \(Fmt.anomalyReason(a.reason))")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverHighlight()
    }

    private func projects(_ t: TodayResponse) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("TOP PROJECTS · TODAY")
                .font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            ForEach(t.topProjects.prefix(3)) { p in
                Link(destination: URL(string: p.href)!) {
                    HStack {
                        Text(p.name).font(.system(size: 13, weight: .medium))
                        Spacer()
                        Text(Fmt.usd(p.usd)).font(.system(size: 13, design: .monospaced))
                    }
                    .contentShape(Rectangle())
                }.buttonStyle(.plain).hoverHighlight()
                // Break a multi-branch/PR project into its features, so a
                // project's spend isn't an opaque lump. Single-feature
                // projects would just duplicate the parent row, so skip them.
                if p.features.count > 1 {
                    ForEach(Array(p.features.enumerated()), id: \.element.id) { idx, f in
                        Link(destination: URL(string: f.href)!) {
                            HStack {
                                Text((idx == p.features.count - 1 ? "└ " : "├ ") + f.name)
                                    .font(.system(size: 11)).foregroundStyle(.secondary)
                                Spacer()
                                Text(Fmt.usd(f.usd))
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.secondary)
                            }
                            .contentShape(Rectangle())
                        }.buttonStyle(.plain).hoverHighlight()
                    }
                }
            }
        }
    }

    private func actions() -> some View {
        HStack(spacing: 4) {
            Link("Open dashboard", destination: URL(string: Api.base + "/")!)
                .hoverHighlight()
            Text("·").foregroundStyle(.secondary)
            Link("Settings", destination: URL(string: Api.base + "/settings")!)
                .hoverHighlight()
            Spacer()
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .hoverHighlight()
        }
        .font(.system(size: 12))
    }

    private func agoText(_ d: Date) -> String {
        let s = max(0, Int(Date().timeIntervalSince(d)))
        if s < 60 { return "\(s)s ago" }
        if s < 3600 { return "\(s/60)m ago" }
        return "\(s/3600)h ago"
    }
}

// MARK: - Breakdown (30-day project totals, hover to expand the tail)

struct BreakdownView: View {
    let trend: Trend
    // Shared with the chart: hovering a row here dims every other band.
    @Binding var focused: String?
    @State private var expanded = false

    // Set/clear the shared focus without clobbering another row's focus when
    // the leave-event of one row races the enter-event of the next.
    private func focus(_ name: String, _ inside: Bool) {
        focused = inside ? name : (focused == name ? nil : focused)
    }

    // Window totals per band key.
    private var totals: [String: Double] {
        trend.days.reduce(into: [:]) { acc, day in
            for (k, v) in day.bands { acc[k, default: 0] += v }
        }
    }
    // The distinct-colored bands (everything except the folded "__other__").
    private var named: [(proj: TrendProject, total: Double)] {
        trend.projects
            .filter { $0.key != "__other__" }
            .map { (proj: $0, total: totals[$0.key] ?? 0) }
            .filter { $0.total > 0 }
            .sorted { $0.total > $1.total }
    }

    var body: some View {
        // The "__other__" band folds many small projects; trend.others is its
        // itemized breakdown, revealed on hover.
        let otherBand = totals["__other__"] ?? 0
        let others = (trend.others ?? []).sorted { $0.totalUsd > $1.totalUsd }
        let othersShown = Array(others.prefix(8))
        let othersRest = others.count - othersShown.count

        return VStack(alignment: .leading, spacing: 4) {
            Text("LAST 30 DAYS")
                .font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            ForEach(named, id: \.proj.key) { row in
                Link(destination: Api.projectURL(row.proj.key)) {
                    breakdownRow(color: row.proj.color, name: row.proj.name, value: row.total)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).hoverHighlight()
                .onHover { focus(row.proj.name, $0) }
            }
            if otherBand > 0 {
                // Click the "Other" row to unfold its itemized tail.
                Button {
                    expanded.toggle()
                } label: {
                    HStack(spacing: 6) {
                        Circle().fill(Color(hex: "#a8a29a")).frame(width: 7, height: 7)
                        Text("Other").font(.system(size: 11)).foregroundStyle(.tertiary)
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 8, weight: .semibold)).foregroundStyle(.tertiary)
                        if !expanded {
                            Text("\(others.count)").font(.system(size: 10)).foregroundStyle(.tertiary)
                        }
                        Spacer()
                        Text(Fmt.usd0(otherBand))
                            .font(.system(size: 11, design: .monospaced)).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverHighlight()
                .onHover { focus("Other", $0) }
                if expanded {
                    // Tail projects are all folded into the one gray "__other__"
                    // band, so hovering any of them focuses "Other" as a group;
                    // clicking opens that specific project.
                    ForEach(othersShown, id: \.key) { o in
                        Link(destination: Api.projectURL(o.key)) {
                            breakdownRow(color: o.color, name: o.name, value: o.totalUsd,
                                         muted: true, indent: true)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).hoverHighlight()
                        .onHover { focus("Other", $0) }
                    }
                    if othersRest > 0 {
                        Text("+\(othersRest) smaller")
                            .font(.system(size: 10)).foregroundStyle(.tertiary)
                            .padding(.leading, 13)
                    }
                }
            }
        }
    }

    private func breakdownRow(color: String, name: String, value: Double,
                              muted: Bool = false, indent: Bool = false) -> some View {
        HStack(spacing: 6) {
            Circle().fill(Color(hex: color)).frame(width: 7, height: 7)
            Text(name).font(.system(size: 11)).foregroundStyle(muted ? .tertiary : .secondary)
                .lineLimit(1).truncationMode(.middle)
            Spacer()
            Text(Fmt.usd0(value))
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(muted ? .tertiary : .secondary)
        }
        .padding(.leading, indent ? 13 : 0)
    }
}

// MARK: - App

struct TokentrailApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        MenuBarExtra {
            PanelView(store: store)
                .onAppear { store.start() }
        } label: {
            // Today's number in the menu bar, with a flame when it's an
            // unusual burn day (hot wins over the panel's live dot). An
            // offline/loading state shows a bare "$—".
            if store.isHot {
                Text("\(Image(systemName: "flame.fill")) \(store.menuTitle)")
            } else {
                Text(store.menuTitle)
            }
        }
        .menuBarExtraStyle(.window)
    }
}

// MARK: - Entry point

@main
enum Main {
    static func main() {
        if let i = CommandLine.arguments.firstIndex(of: "--render-png"),
           i + 1 < CommandLine.arguments.count {
            renderPNG(to: CommandLine.arguments[i + 1])
            return
        }
        TokentrailApp.main()
    }

    // Headless verification: fetch once, render the panel to a PNG, exit.
    @MainActor
    static func renderPNG(to path: String) {
        let data = Api.fetchSync()
        let store = Store(preloaded: data)
        let view = PanelView(store: store)
            .background(Color(nsColor: .windowBackgroundColor))
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        if let img = renderer.nsImage,
           let tiff = img.tiffRepresentation,
           let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path))
            FileHandle.standardError.write("rendered \(img.size) → \(path)\n".data(using: .utf8)!)
        } else {
            FileHandle.standardError.write("render failed\n".data(using: .utf8)!)
        }
        exit(0)
    }
}
