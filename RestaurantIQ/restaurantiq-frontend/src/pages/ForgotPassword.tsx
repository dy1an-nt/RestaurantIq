import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../components/auth/AuthContext';
import AuthShell from '../components/auth/AuthShell';
import Icon from '../components/Icons';

const inputWrap =
  'flex items-center gap-[10px] h-11 px-[14px] border border-line rounded-[9px] bg-surface text-ink-3 transition-shadow focus-within:border-navy-500 focus-within:shadow-[0_0_0_3px_#f1f5fa]';
const inputField =
  'border-0 outline-none bg-transparent w-full text-sm text-ink placeholder:text-ink-3';

const ForgotPassword = () => {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { resetPasswordForEmail } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const { error } = await resetPasswordForEmail(email);

    if (error) {
      setError(error.message);
    } else {
      setSent(true);
    }

    setLoading(false);
  };

  return (
    <AuthShell mode="login" hideTabs>
      {sent ? (
        <div className="text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-pos-bg flex items-center justify-center mx-auto">
            <Icon name="mail" size={22} className="text-pos" />
          </div>
          <h1 className="text-[22px] font-extrabold tracking-tighter text-ink">Check your email</h1>
          <p className="text-sm text-ink-3 leading-relaxed">
            We sent a password reset link to <b className="text-ink">{email}</b>. Click the link to set a new password.
          </p>
          <p className="text-[13px] text-ink-3">
            Back to{' '}
            <Link to="/login" className="font-bold text-navy-700 hover:text-navy-800">
              Sign in
            </Link>
          </p>
        </div>
      ) : (
        <>
          <h1 className="text-[25px] font-extrabold tracking-tighter text-ink">Reset your password</h1>
          <p className="mt-1.5 mb-[26px] text-sm font-medium text-ink-3">
            Enter your email and we'll send you a reset link.
          </p>

          <form onSubmit={handleSubmit}>
            {error && (
              <div className="mb-4 rounded-sm bg-neg-bg border border-neg/30 px-4 py-3 text-sm text-neg">
                {error}
              </div>
            )}

            <div className="mb-6">
              <label htmlFor="email" className="block mb-[7px] text-[12.5px] font-bold text-ink-2">
                Email address
              </label>
              <div className={inputWrap}>
                <Icon name="mail" size={17} />
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@restaurant.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputField}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-[46px] rounded-[9px] bg-navy-700 text-white text-[15px] font-bold hover:bg-navy-800 transition-colors disabled:opacity-50"
            >
              {loading ? 'Sending…' : 'Send reset link'}
            </button>

            <p className="mt-[26px] text-center text-[13px] font-medium text-ink-3">
              Remember it?{' '}
              <Link to="/login" className="font-bold text-navy-700 hover:text-navy-800">
                Sign in
              </Link>
            </p>
          </form>
        </>
      )}
    </AuthShell>
  );
};

export default ForgotPassword;
