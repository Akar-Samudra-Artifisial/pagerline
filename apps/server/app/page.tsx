export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Pagerline server</h1>
      <p>Webhook ingest + alert feed for the Pagerline G2 glasses app.</p>
      <ul>
        <li>POST /api/webhooks/github</li>
        <li>POST /api/webhooks/sentry</li>
        <li>GET /api/alerts?since=&lt;cursor&gt; (Bearer device token)</li>
        <li>POST /api/pair/start · GET /api/pair/status (Bearer poll secret)</li>
        <li>POST /api/actions/intent · POST /api/actions/confirm (Bearer paired device token)</li>
        <li>GET /api/audit (Bearer device token or admin secret)</li>
        <li>
          <a href="/pair">/pair</a> · <a href="/audit">/audit</a> (admin secret)
        </li>
      </ul>
    </main>
  )
}
