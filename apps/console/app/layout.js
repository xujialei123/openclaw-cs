import "./globals.css";

export const metadata = {
  title: "OpenClaw 控制台",
  description: "边端配置 · 查单 · 巡检",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
