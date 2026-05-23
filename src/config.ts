export const SITE = {
  website: "https://example.com",
  author: "Author",
  profile: "/",
  desc: "A minimal, responsive and SEO-friendly blog.",
  title: "Blog",
  ogImage: "",
  repository: "",
  lightAndDarkMode: true,
  postPerIndex: 4,
  postPerPage: 4,
  postsTree: {
    maxSubdirectoriesPerDirectory: 6,
    maxPostsPerDirectory: 4,
    directoryIntroFileName: "README",
    directoryLabelFallback: "default-locale",
    postLocaleFallback: "none",
  },
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: true,
  showBackButton: true, // show back button in post detail
  editPost: {
    enabled: true,
    text: "Edit page",
    url: "/",
  },
  dynamicOgImage: true,
  dir: "ltr", // "rtl" | "auto"
  lang: "en", // html lang code. Set this empty and default will be "en"
  timezone: "Asia/Bangkok", // Default global timezone (IANA format) https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
} as const;
