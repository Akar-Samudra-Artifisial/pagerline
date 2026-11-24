import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // @pagerline/shared ships TypeScript source from the workspace.
  transpilePackages: ['@pagerline/shared'],
  // Webhook routes need the raw body for HMAC verification; nothing else to tune yet.
}

export default nextConfig
