/** The panel every group of settings sits on. */
export default function SettingCard({ children, className = '' }) {
    return (
        <div
            className={`bg-surface-control/50 border border-surface-control/60
                rounded-xl p-6 ${className}`}
        >
            {children}
        </div>
    );
}
