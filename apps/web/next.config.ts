import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@kestrel/db', '@kestrel/model'],
  serverExternalPackages: ['pg'],
};

export default config;
