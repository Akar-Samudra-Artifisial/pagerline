export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Pagerline server</h1>
      <p>Webhook ingest + alert feed for the Pagerline G2 glasses app.</p>
      <ul>
        <li>POST /api/webhooks/github</li>
        <li>POST /api/webhooks/sentry</li>
        <li>GET /api/alerts?since=&lt;cursor&gt; (Bearer device token)</li>
      </ul>
    </main>
  )
}
