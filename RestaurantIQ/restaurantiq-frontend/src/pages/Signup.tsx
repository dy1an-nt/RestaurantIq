import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../components/auth/AuthContext';
import AuthShell from '../components/auth/AuthShell';
import Icon from '../components/Icons';

const inputWrap =
  'flex items-center gap-[10px] h-11 px-[14px] border border-line rounded-[9px] bg-surface text-ink-3 transition-shadow focus-within:border-navy-500 focus-within:shadow-[0_0_0_3px_#f1f5fa]';
const inputField =
  'border-0 outline-none bg-transparent w-full text-sm text-ink placeholder:text-ink-3';

const Signup = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { signUp } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      setLoading(false);
      return;
    }

    const { error } = await signUp(email, password);

    if (error) {
      setError(error.message);
    } else {
      navigate('/onboarding');
    }

    setLoading(false);
  };

  return (
    <AuthShell mode="signup">
      <h1 className="text-[25px] font-extrabold tracking-tighter text-ink">Create your account</h1>
      <p className="mt-1.5 mb-[26px] text-sm font-medium text-ink-3">
        Start tracking your menu performance in minutes.
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
              autoComplete="new-password"
              required
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputField}
            />
          </div>
        </div>

        <div className="mb-[22px]">
          <label htmlFor="confirmPassword" className="block mb-[7px] text-[12.5px] font-bold text-ink-2">
            Confirm password
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
          {loading ? 'Creating account…' : 'Create account'}
        </button>

        <p className="mt-[26px] text-center text-[13px] font-medium text-ink-3">
          Already have an account?{' '}
          <Link to="/login" className="font-bold text-navy-700">
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
};

export default Signup;
