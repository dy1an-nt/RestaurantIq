/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          50:  '#f1f5fa',
          100: '#e6edf5',
          500: '#3d5d86',
          600: '#2b4a72',
          700: '#1e3a5f', // ← primary brand
          800: '#1b3147',
          900: '#14283f',
        },
        ink: {
          DEFAULT: '#1f2733', // primary text
          2: '#4a5564',       // secondary text
          3: '#76808f',       // muted / labels
        },
        line: {
          DEFAULT: '#e4e7ec', // hairline border
          2: '#eef0f3',       // lighter divider
        },
        surface: '#ffffff',
        canvas: '#f6f7f9',       // light-grey app background
        'canvas-warm': '#f7f6f3',
        // muted, professional data colors
        pos:  { DEFAULT: '#2f7a5b', bg: '#e9f1ec' }, // good / up
        neg:  { DEFAULT: '#b25140', bg: '#f4eae7' }, // bad / down
        warn: { DEFAULT: '#9a7320', bg: '#f6f0e1' }, // attention
      },
      fontFamily: {
        sans: ['"Hanken Grotesk"', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '10px', // cards
        sm: '7px',
        lg: '14px',      // product-shot frame
      },
      boxShadow: {
        sm: '0 1px 2px rgba(20,40,63,.05)',
        DEFAULT: '0 1px 3px rgba(20,40,63,.07), 0 6px 16px rgba(20,40,63,.05)',
        // hero product shot
        shot: '0 2px 6px rgba(20,40,63,.06), 0 30px 70px -24px rgba(20,40,63,.34)',
      },
      letterSpacing: {
        tightest: '-0.035em', // marketing headlines
        tighter: '-0.025em',  // section / card titles
      },
    },
  },
  plugins: [],
}
