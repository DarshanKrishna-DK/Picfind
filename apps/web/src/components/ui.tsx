import { type ReactNode } from 'react';
import { Link } from 'react-router';
import { Image as ImageIcon } from 'lucide-react';
import logo from '../assets/picfind-logo-small.webp';

export function ErrorNote({ error }: { error: unknown }) {
  return error ? (
    <p className="error-note" role="alert">
      {errorMessage(error)}
    </p>
  ) : null;
}

export function Loading() {
  return (
    <div className="skeletons" role="status" aria-label="Loading">
      <div />
      <div />
      <div />
    </div>
  );
}

export function Brand() {
  return (
    <Link to="/" className="brand">
      <img src={logo} alt="" />
      <span>
        picfind<span className="brand-dot">.</span>
      </span>
    </Link>
  );
}

export function PageTitle({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {children}
    </div>
  );
}

export function Empty({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-art">
        <ImageIcon size={42} strokeWidth={1} />
      </div>
      <h2>{title}</h2>
      <p>{text}</p>
      {children}
    </div>
  );
}

export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.';
