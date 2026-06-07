import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../components/auth/AuthContext';
import AuthShell from '../components/auth/AuthShell';
import Icon from '../components/Icons';

const inputWrap =
  'flex items-center gap-[10px] h-11 px-[14px] border border-line rounded-[9px] bg-surface text-ink-3 transition-shadow focus-within:border-navy-500 focus-within:shadow-[0_0_0_3px_#f1f5fa]';
const inputField =
  'border-0 outline-none bg-transparent w-full text-sm text-ink placeholder:text-ink-3';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const { error } = await signIn(email, password);

    if (error) {
      setError(error.message);
    } else {
      navigate('/');
    }

    setLoading(false);
  };

  return (
    <AuthShell mode="login">
      <h1 className="text-[25px] font-extrabold tracking-tighter text-ink">Welcome back</h1>
      <p className="mt-1.5 mb-[26px] text-sm font-medium text-ink-3">
        Sign in to your RestaurantIQ dashboard.
      </p>

      <form onSubmit={handleSubmit}>
        {error && (
          <div className="mb-4 rounded-sm bg-neg-bg border border-neg/30 px-4 py-3 text-sm text-neg">
            {error}
          </div>
        )}

        <div className="mb-4">
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

        <div className="mb-4">
          <label htmlFor="password" className="block mb-[7px] text-[12.5px] font-bold text-ink-2">
            Password
          </label>
          <div className={inputWrap}>
            <Icon name="lock" size={17} />
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputField}
            />
          </div>
        </div>

        <div className="flex items-center justify-between -mt-0.5 mb-[22px]">
          <button
            type="button"
            onClick={() => setRemember((r) => !r)}
            className="flex items-center gap-2 text-[13px] font-semibold text-ink-2"
          >
            <span
              className={`w-[17px] h-[17px] rounded-[5px] border flex items-center justify-center text-white ${
                remember ? 'bg-navy-700 border-navy-700' : 'bg-surface border-line'
              }`}
            >
              {remember && <Icon name="check" size={12} strokeWidth={2.4} />}
            </span>
            Remember me
          </button>
          <Link to="/forgot-password" className="text-[13px] font-semibold text-navy-700 hover:text-navy-800">
            Forgot password?
          </Link>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full h-[46px] rounded-[9px] bg-navy-700 text-white text-[15px] font-bold hover:bg-navy-800 transition-colors disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="mt-[26px] text-center text-[13px] font-medium text-ink-3">
          Don't have an account?{' '}
          <Link to="/signup" className="font-bold text-navy-700">
            Create one
          </Link>
        </p>
      </form>
    </AuthShell>
  );
};

export default Login;
