/// <reference path="../app.d.ts" />
/// <reference path="../core.d.ts" />
/// <reference path="../plugin.d.ts" />

// Open Custom Sources
//
// Adds a tray shortcut that navigates to the Custom Sources manager page.
// The tray icon and the $ui.register callback run in the UI VM, so every
// constant used below is declared inside the callback (see note in ListSync).

function init() {
	$ui.register((ctx) => {
		const TRAY_ICON = "https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/OpenCustomSources/icon.png";

		// `ctx.screen` is not yet typed in plugin.d.ts but is bound by the app
		// (internal/plugin/ui/screen.go). Access it through `any` like ListSync
		// does for `ctx.dom`.
		const screen = (ctx as any).screen;

		const tray = ctx.newTray({
			iconUrl: TRAY_ICON,
			withContent: true,
			width: "22rem",
		});

		function openCustomSources(): void {
			screen.navigateTo("/custom-sources");
			tray.close();
		}

		tray.render(() => {
			const items: any[] = [
				tray.text("Open Custom Sources", { className: "font-semibold text-lg" }),
				tray.text("Browse your installed custom-source catalogs (TMDB, SIMKL, ...).", { className: "text-sm opacity-70" }),
				tray.stack(
					[
						tray.button("Open Custom Sources", {
							intent: "primary",
							size: "md",
							onClick: ctx.eventHandler("opencustomsources:tray:open", () => openCustomSources()),
						}),
					],
					{ gap: 8 }
				),
			];

			return tray.stack(items, { gap: 10 });
		});
	});
}