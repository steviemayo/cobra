import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@kestrel/db', '@kestrel/model', '@kestrel/engine'],
  serverExternalPackages: ['pg'],
  async redirects() {
    return [{ source: '/dashboard', destination: '/', permanent: false }];
  },
};

export default config;
