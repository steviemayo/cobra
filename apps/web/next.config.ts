import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@kestrel/db', '@kestrel/model', '@kestrel/engine'],
  serverExternalPackages: ['pg'],
};

export default config;
