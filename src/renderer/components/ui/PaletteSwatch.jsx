/**
 * A palette as a small window: title bar, sidebar, card. Shared between
 * AppearancePage's full tint grid and ThemeSwitcherContent's compact one, so
 * a palette previews the same wherever it's picked from.
 */
export default function PaletteSwatch({ colors }) {
    return (
        <div
            className="w-full h-14 rounded-lg overflow-hidden p-1.5 flex flex-col gap-1"
            style={{ backgroundColor: colors.base }}
        >
            <div className="flex items-center gap-1">
                <div className="h-2.5 w-8 rounded" style={{ backgroundColor: colors.control }} />
                <div className="h-2.5 w-5 rounded" style={{ backgroundColor: colors.raised }} />
            </div>
            <div className="flex gap-1 flex-1">
                <div className="w-3 rounded" style={{ backgroundColor: colors.raised }} />
                <div className="flex-1 rounded p-1 flex flex-col gap-1" style={{ backgroundColor: colors.raised }}>
                    <div className="h-1 w-8 rounded-full" style={{ backgroundColor: colors.muted }} />
                    <div className="h-1.5 w-5 rounded" style={{ backgroundColor: colors.active }} />
                </div>
            </div>
        </div>
    );
}
