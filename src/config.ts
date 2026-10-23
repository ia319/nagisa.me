export const SITE = {
  website: "https://nagisa.me",
  author: "ia",
  profile: "https://github.com/ia319",
  desc: "Articles, notes, and thoughts by ia.",
  title: "Nagisa",
  ogImage: "",
  repository: "https://github.com/ia319/nagisa.me",
  contentGitMeta: {
    enabled: true,
  },
  lightAndDarkMode: true,
  postPerIndex: 4,
  postPerPage: 4,
  postsTree: {
    maxSubdirectoriesPerDirectory: 6,
    maxPostsPerDirectory: 4,
    directoryIntroFileName: "README",
    directoryLabelFallback: "default-locale",
    postLocaleFallback: "none",
    directoryDefaultOpen: true,
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
  timezone: "Asia/Bangkok", // Default global timezone (IANA format) https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
} as const;
