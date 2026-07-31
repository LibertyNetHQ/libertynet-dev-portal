/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: no server component, so this can be hosted anywhere and there
  // is no backend that could accidentally log a token. Every call the dashboard
  // makes is either public or authenticated by a token the user's own browser
  // obtained and holds in memory.
  output: "export",
  reactStrictMode: true,
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
