/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared package ships TypeScript source, so it has to go through the compiler.
  transpilePackages: ["@slate/shared"],
};

export default nextConfig;
