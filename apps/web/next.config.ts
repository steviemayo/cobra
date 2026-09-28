import type { NextConfig } from 'next';
import { securityHeaders } from './src/lib/security-headers';

const config: NextConfig = {
  transpilePackages: [
    '@kestrel/db',
    '@kestrel/model',
    '@kestrel/engine',
    '@kestrel/drivers',
    '@kestrel/panel-ui',
    '@kestrel/crypto',
  ],
  serverExternalPackages: ['pg'],
  async redirects() {
    return [{ source: '/dashboard', destination: '/', permanent: false }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders() }];
  },
};

export default config;
