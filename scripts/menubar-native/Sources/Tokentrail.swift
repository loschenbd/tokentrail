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

// MARK: - Chart

private struct StackPoint: Identifiable {
    let id = UUID()
    let date: Date
    let project: String
    let usd: Double
}

struct TrendChart: View {
    let trend: Trend

    // Projects ordered bottom→top by stackPosition; __other__ folded to gray.
    private var ordered: [TrendProject] {
        trend.projects.sorted { $0.stackPosition < $1.stackPosition }
    }
    private var domain: [String] { ordered.map(\.name) }
    private var range: [Color] {
        ordered.map { $0.key == "__other__" ? Color.gray.opacity(0.5) : Color(hex: $0.color) }
    }
    private var points: [StackPoint] {
        var out: [StackPoint] = []
        let keyToName = Dictionary(uniqueKeysWithValues: ordered.map { ($0.key, $0.name) })
        for day in trend.days {
            guard let d = Fmt.dayDate(day.date) else { continue }
            for p in ordered {
                let usd = day.bands[p.key] ?? 0
                out.append(StackPoint(date: d, project: keyToName[p.key] ?? p.key, usd: usd))
            }
        }
        return out
    }

    var body: some View {
        Chart(points) { pt in
            AreaMark(
                x: .value("Date", pt.date),
                y: .value("USD", pt.usd),
                stacking: .standard
            )
            .foregroundStyle(by: .value("Project", pt.project))
            .interpolationMethod(.monotone)
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
    }
}

// MARK: - Panel

struct PanelView: View {
    @ObservedObject var store: Store

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let t = store.today {
                header(t)
                Divider()
                statBlock(t)
                if t.menubar.trend.days.count >= 2 {
                    TrendChart(trend: t.menubar.trend)
                    legend(t.menubar.trend)
                }
                Divider()
                worthALook(t)
                if !t.topProjects.isEmpty {
                    Divider()
                    projects(t)
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

    private func header(_ t: TodayResponse) -> some View {
        HStack(spacing: 6) {
            if store.isLive {
                Circle().fill(Color(hex: "#5f6f5e")).frame(width: 7, height: 7)
            }
            Text("~" + Fmt.usd(t.todayUsd))
                .font(.system(size: 20, weight: .semibold, design: .rounded))
            Spacer()
            if let iso = t.lastEventAt, let d = Fmt.isoDate(iso) {
                Text(agoText(d)).font(.caption).foregroundStyle(.secondary)
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

    private func legend(_ trend: Trend) -> some View {
        let totals: [String: Double] = trend.days.reduce(into: [:]) { acc, day in
            for (k, v) in day.bands { acc[k, default: 0] += v }
        }
        let top = trend.projects
            .map { ($0, totals[$0.key] ?? 0) }
            .filter { $0.1 > 0 && $0.0.key != "__other__" }
            .sorted { $0.1 > $1.1 }
            .prefix(3)
        return HStack(spacing: 12) {
            ForEach(Array(top), id: \.0.key) { p, total in
                HStack(spacing: 4) {
                    Circle().fill(Color(hex: p.color)).frame(width: 7, height: 7)
                    Text(p.name).font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
    }

    private func worthALook(_ t: TodayResponse) -> some View {
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
                }.buttonStyle(.plain)
            }
        }
    }

    private func actions() -> some View {
        HStack {
            Link("Open dashboard", destination: URL(string: Api.base + "/")!)
            Text("·").foregroundStyle(.secondary)
            Link("Settings", destination: URL(string: Api.base + "/settings")!)
            Spacer()
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.plain).foregroundStyle(.secondary)
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
