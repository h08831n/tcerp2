import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          50: "#f0f5fa",
          100: "#dce7f3",
          200: "#c0d4e8",
          300: "#95b6d7",
          400: "#6392c2",
          500: "#4174a9",
          600: "#325d8f",
          700: "#2b4c74",
          800: "#284161",
          900: "#263852",
          950: "#192535",
        },
      },
      fontFamily: {
        sans: ["var(--font-vazirmatn)", "Tahoma", "Arial", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
