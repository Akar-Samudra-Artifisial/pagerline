import { PairForms } from './pair-forms'

export const metadata = { title: 'Pagerline · pair glasses' }

export default function PairPage() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Pair glasses</h1>
      <p>
        Start pairing on the glasses, then approve the 6-character code here. The admin secret is checked on every
        submit and never stored in the browser.
      </p>
      <PairForms />
    </main>
  )
}
