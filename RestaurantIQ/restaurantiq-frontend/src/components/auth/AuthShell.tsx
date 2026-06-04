import { Link } from 'react-router-dom';
import Logo from '../Logo';

interface AuthShellProps {
  mode: 'login' | 'signup';
  children: React.ReactNode;
}

/**
 * Split-screen auth layout: a navy brand/marketing panel on the left and a
 * centered form column on the right. The segmented tab control maps directly
 * to the existing `/login` and `/signup` routes.
 */
const AuthShell = ({ mode, children }: AuthShellProps) => {
  const isLogin = mode === 'login';

  return (
    <div className="flex min-h-screen w-full bg-surface text-ink">
      {/* Brand panel */}
      <div className="hidden lg:flex w-[42%] flex-shrink-0 bg-navy-700 text-white px-[46px] py-11 flex-col relative overflow-hidden">
        {/* decorative concentric circles */}
        <span className="absolute -right-[120px] -bottom-[120px] w-[340px] h-[340px] rounded-full border border-white/[0.08]" />
        <span className="absolute -right-[60px] -bottom-[60px] w-[220px] h-[220px] rounded-full border border-white/[0.08]" />

        <div className="flex items-center gap-[11px]">
          <Logo size={32} on="light" />
          <span className="text-[19px] font-extrabold tracking-[-0.03em]">RestaurantIQ</span>
        </div>

        <div className="mt-auto relative z-[1]">
          <h2 className="text-[30px] leading-[1.18] font-extrabold tracking-tighter max-w-[13ch]">
            Know what to promote, cut, or reprice.
          </h2>
          <p className="mt-4 text-[15px] leading-[1.55] text-white/70 max-w-[34ch]">
            RestaurantIQ syncs your POS and delivery orders, then turns the numbers into plain-English decisions.
          </p>
          <div className="flex gap-[30px] mt-[30px]">
            <div>
              <b className="block text-2xl font-extrabold tracking-[-0.02em]">$56k</b>
              <span className="text-xs font-semibold text-white/60">tracked / mo</span>
            </div>
            <div>
              <b className="block text-2xl font-extrabold tracking-[-0.02em]">124</b>
              <span className="text-xs font-semibold text-white/60">menu items</span>
            </div>
            <div>
              <b className="block text-2xl font-extrabold tracking-[-0.02em]">8.4%</b>
              <span className="text-xs font-semibold text-white/60">revenue lift</span>
            </div>
          </div>
        </div>

        <div className="mt-[34px] pt-[22px] border-t border-white/[0.12] text-[13.5px] leading-[1.6] text-white/80 relative z-[1]">
          “I finally stopped guessing which dishes actually make money. Cut three, repriced two, margins are up.”
          <div className="mt-3 flex items-center gap-[10px]">
            <span className="w-8 h-8 rounded-full bg-white/[0.16] flex items-center justify-center text-xs font-extrabold">
              DM
            </span>
            <span className="text-[12.5px] leading-tight">
              <b className="block font-bold text-white">Daniel Marino</b>
              <span className="text-white/60">Owner, Bella Trattoria</span>
            </span>
          </div>
        </div>
      </div>

      {/* Form column */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-[380px]">
          {/* Tab switch */}
          <div className="flex gap-1 bg-canvas border border-line rounded p-1 mb-7">
            <Link
              to="/login"
              className={`flex-1 text-center py-[9px] rounded-sm text-[13.5px] font-bold transition-colors ${
                isLogin ? 'bg-surface text-navy-700 shadow-sm' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              Sign in
            </Link>
            <Link
              to="/signup"
              className={`flex-1 text-center py-[9px] rounded-sm text-[13.5px] font-bold transition-colors ${
                !isLogin ? 'bg-surface text-navy-700 shadow-sm' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              Create account
            </Link>
          </div>

          {children}
        </div>
      </div>
    </div>
  );
};

export default AuthShell;
