import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ts-clipper',
  description: 'Clip and share videos',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
