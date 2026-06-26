# Build a macOS .app launcher for Tokentrail.
#
#   make app       → builds dist/Tokentrail.app from docs/logo.png
#   make install   → builds + copies the .app to /Applications/
#   make clean     → removes dist/
#
# The .app is a thin launcher: it opens http://127.0.0.1:9876/ in your
# browser, spawning the dashboard server first if needed. See launch.sh.

APP_NAME   := Tokentrail
BUNDLE_ID  := com.benjaminloschen.tokentrail
REPO_ROOT  := $(shell git rev-parse --show-toplevel)
VERSION    := $(shell node -p "require('$(REPO_ROOT)/package.json').version")
DIST       := dist
APP        := $(DIST)/$(APP_NAME).app
ICON_SRC   := $(REPO_ROOT)/docs/logo.png
ICONSET    := $(DIST)/$(APP_NAME).iconset
ICNS       := $(DIST)/$(APP_NAME).icns

.PHONY: app install clean

app: $(APP)
	@echo
	@echo "Built $(APP) (v$(VERSION))"
	@echo "Install:  make install        # copies to /Applications/"
	@echo "Or:       cp -r $(APP) /Applications/"
	@echo

$(APP): $(ICNS) Info.plist launch.sh
	@rm -rf $(APP)
	@mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	@sed "s/{{VERSION}}/$(VERSION)/g" Info.plist > $(APP)/Contents/Info.plist
	@cp launch.sh $(APP)/Contents/MacOS/$(APP_NAME)
	@chmod +x $(APP)/Contents/MacOS/$(APP_NAME)
	@cp $(ICNS) $(APP)/Contents/Resources/$(APP_NAME).icns

$(ICNS): $(ICON_SRC)
	@rm -rf $(ICONSET)
	@mkdir -p $(ICONSET)
	@# docs/logo.png is actually a JPEG; force PNG output so iconutil accepts it.
	@for size in 16 32 128 256 512; do \
		dbl=$$((size * 2)); \
		sips -s format png -z $$size $$size $(ICON_SRC) --out $(ICONSET)/icon_$${size}x$${size}.png >/dev/null; \
		sips -s format png -z $$dbl $$dbl $(ICON_SRC) --out $(ICONSET)/icon_$${size}x$${size}@2x.png >/dev/null; \
	done
	@iconutil -c icns -o $(ICNS) $(ICONSET)
	@rm -rf $(ICONSET)

install: $(APP)
	@rm -rf /Applications/$(APP_NAME).app
	@cp -r $(APP) /Applications/$(APP_NAME).app
	@echo "Installed /Applications/$(APP_NAME).app"

clean:
	rm -rf $(DIST)
