/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: "#FFFFFF",
        accent: "#EFF6FF",
        ink: "#1F2937",
        brand: "#3B82F6",
        mist: "#F8FAFC",
        line: "#D9E7FF"
      },
      fontFamily: {
        sans: [
          "SF Pro Display",
          "SF Pro Text",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif"
        ],
        mono: ["IBM Plex Mono", "SFMono-Regular", "ui-monospace", "monospace"]
      },
      boxShadow: {
        panel: "0 22px 50px rgba(15, 23, 42, 0.05)",
        soft: "0 10px 28px rgba(15, 23, 42, 0.04)"
      }
    }
  },
  plugins: []
};
