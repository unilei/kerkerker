import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { SWRProvider } from "@/components/providers/swr-provider";
import { LocaleProvider } from "@/components/providers/locale-provider";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  parseSupportedLocale,
} from "@/lib/locale";
import {
  absoluteUrl,
  SITE_DESCRIPTION,
  SITE_IMAGE_URL,
  SITE_NAME,
  SITE_URL,
} from "@/lib/seo";
import { StructuredData } from "@/components/seo/StructuredData";
import { cookies } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} | 短剧信息与网盘资源导航`,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  category: "entertainment",
  creator: SITE_NAME,
  publisher: SITE_NAME,
  alternates: { canonical: "/" },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    title: `${SITE_NAME} | 短剧信息与网盘资源导航`,
    description: SITE_DESCRIPTION,
    siteName: SITE_NAME,
    locale: "zh_CN",
    images: [{ url: SITE_IMAGE_URL, alt: `${SITE_NAME} logo` }],
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} | 短剧信息与网盘资源导航`,
    description: SITE_DESCRIPTION,
    images: [SITE_IMAGE_URL],
  },
  icons: { icon: absoluteUrl("/favicon.ico") },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale =
    parseSupportedLocale((await cookies()).get(LOCALE_COOKIE_NAME)?.value) ||
    DEFAULT_LOCALE;

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/* 移动端布局优化 - 适配刘海屏与沉浸式状态栏 */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="format-detection" content="telephone=no" />
        <meta name="x5-fullscreen" content="true" />
        <meta name="x5-page-mode" content="app" />
        <meta name="browsermode" content="application" />

        {/* Google Analytics */}
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-FXGFKZZHR7"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-FXGFKZZHR7');
          `}
        </Script>
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        <StructuredData />
        <LocaleProvider initialLocale={locale}>
          <SWRProvider>{children}</SWRProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
