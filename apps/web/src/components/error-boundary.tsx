import { Component, type ReactNode } from 'react';
export class ProductBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    // Do not log user content, callback tokens, or private photo URLs.
    console.error('PicFind could not display this page.');
  }
  render() {
    return this.state.failed ? (
      <main className="wrap standalone recovery-card">
        <p className="eyebrow">PICFIND / PAGE RECOVERY</p>
        <h1>Let's get you back.</h1>
        <p role="alert">
          This page could not be displayed. Your saved photos have not been
          changed.
        </p>
        <button className="button" onClick={() => window.location.reload()}>
          Reload page
        </button>{' '}
        <a className="text-link" href="/">
          Return home
        </a>
      </main>
    ) : (
      this.props.children
    );
  }
}
