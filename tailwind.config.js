/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 北農品牌色（取自 LOGO）：藍紫 #623BFC / 洋紅 #EE058A / 橘 #F95509 / 炭黑 #2B2320
        primary: {
          50: "#f4f1ff",
          100: "#eae4ff",
          200: "#d6cbff",
          300: "#b8a3ff",
          400: "#9272ff",
          500: "#7a4dfe",
          600: "#623bfc",
          700: "#4e28e0",
          800: "#4022b4",
          900: "#361e8c",
        },
        brand: {
          blue: "#623bfc",
          pink: "#ee058a",
          orange: "#f95509",
          ink: "#2b2320",
        },
      },
    },
  },
  plugins: [],
};
