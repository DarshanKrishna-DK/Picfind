import { useEffect, useState, type MouseEvent } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import { Brand } from '../components/ui';
import { useQuery } from '@tanstack/react-query';
import { session } from '../api';

function scrollToSection(id: string) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById(id)?.scrollIntoView({
    behavior: reduced ? 'instant' : 'smooth',
    block: 'start',
  });
}

export function PublicLayout() {
  const account = useQuery({ queryKey: ['session'], queryFn: session });
  const [menu, setMenu] = useState(false);
  const location = useLocation();
  useEffect(() => {
    setMenu(false);
    if (location.hash) {
      const id = location.hash.slice(1);
      const frame = requestAnimationFrame(() => scrollToSection(id));
      return () => cancelAnimationFrame(frame);
    }
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }, [location.pathname, location.hash]);
  const goToSection =
    (id: string) => (event: MouseEvent<HTMLAnchorElement>) => {
      setMenu(false);
      if (location.pathname !== '/') return;
      if (location.hash === `#${id}`) {
        event.preventDefault();
        scrollToSection(id);
      }
    };
  return (
    <div className="public-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="public-header">
        <Brand />
        <button
          className="icon-button mobile-menu"
          aria-label="Toggle navigation"
          aria-expanded={menu}
          aria-controls="public-navigation"
          onClick={() => setMenu(!menu)}
        >
          {menu ? <X size={21} /> : <Menu size={21} />}
        </button>
        <nav
          id="public-navigation"
          className={`public-nav ${menu ? 'is-open' : ''}`}
          aria-label="Main navigation"
        >
          <Link to="/#discover" onClick={goToSection('discover')}>
            Discover
          </Link>
          <Link to="/#events" onClick={goToSection('events')}>
            Events
          </Link>
          <Link to="/#pricing" onClick={goToSection('pricing')}>
            Pricing
          </Link>
          <Link to="/#faq" onClick={goToSection('faq')}>
            FAQ
          </Link>
          {account.data ? (
            <Link className="button compact" to="/app">
              Open your studio <ArrowUpRight size={16} />
            </Link>
          ) : !account.isPending ? (
            <Link className="button compact" to="/sign-in">
              Sign in
            </Link>
          ) : null}
        </nav>
      </header>
      <main id="main">
        <Outlet />
      </main>
      <footer className="public-footer">
        <div>
          <Brand />
          <p>Find your moments. Keep the good ones.</p>
        </div>
        <nav aria-label="Footer">
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
          <Link to="/contact">Contact</Link>
        </nav>
        <span>PicFind / {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
