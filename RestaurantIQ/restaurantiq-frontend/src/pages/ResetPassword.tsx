import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../components/auth/AuthContext';
import AuthShell from '../components/auth/AuthShell';
import Icon from '../components/Icons';
import { supabase } from '../lib/supabase';

const inputWrap =
  'flex items-center gap-[10px] h-11 px-[14px] border border-line rounded-[9px] bg-surface text-ink-3 transition-shadow focus-within:border-navy-500 focus-within:shadow-[0_0_0_3px_#f1f5fa]';
const inputField =
  'border-0 outline-none bg-transparent w-full text-sm text-ink placeholder:text-ink-3';

const ResetPassword = () => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const { updatePassword } = useAuth();
  const navigate = useNavigate();

  // Supabase sends the recovery token in the URL hash. The SDK fires
  // PASSWORD_RECOVERY via onAuthStateChange once the hash is consumed.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setReady(true);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);
    setError('');

    const { error } = await updatePassword(password);

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      navigate('/', { replace: true });
    }
  };

  return (
    <AuthShell mode="login" hideTabs>
      {!ready ? (
        <div className="text-center space-y-3 py-4">
          <p className="text-sm text-ink-3">Verifying your reset link…</p>
        </div>
      ) : (
        <>
          <h1 className="text-[25px] font-extrabold tracking-tighter text-ink">Set new password</h1>
          <p className="mt-1.5 mb-[26px] text-sm font-medium text-ink-3">
            Choose a new password for your account.
          </p>

          <form onSubmit={handleSubmit}>
            {error && (
              <div className="mb-4 rounded-sm bg-neg-bg border border-neg/30 px-4 py-3 text-sm text-neg">
                {error}
              </div>
            )}

            <div className="mb-4">
              <label htmlFor="password" className="block mb-[7px] text-[12.5px] font-bold text-ink-2">
                New password
              </label>
              <div className={inputWrap}>
                <Icon name="lock" size={17} />
                <input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputField}
                />
              </div>
            </div>

            <div className="mb-6">
              <label htmlFor="confirmPassword" className="block mb-[7px] text-[12.5px] font-bold text-ink-2">
                Confirm new password
              </label>
              <div className={inputWrap}>
                <Icon name="lock" size={17} />
                <input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={inputField}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-[46px] rounded-[9px] bg-navy-700 text-white text-[15px] font-bold hover:bg-navy-800 transition-colors disabled:opacity-50"
            >
              {loading ? 'Saving…' : 'Set new password'}
            </button>
          </form>
        </>
      )}
    </AuthShell>
  );
};

export default ResetPassword;
