module.exports = {
  MODERATORS: ['oy-ladygain', 'oy-0nlyoung7'],
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
  TOXICITY: {
    MODERATION_REQUIRED: 3,
    AUTO_DELETE: 4,
  },
  GITHUB: {
    OWNER: process.env.TECH_BLOG_OWNER || 'oy-alldev',
    REPO: process.env.TECH_BLOG_REPO || 'oliveyoung-tech-blog',
  },
  POST_PATTERN: /(\d{4}-\d{2}-\d{2})[-\/]([^\/\s?#]+)/,
  METRICS: {
    LABEL: 'metrics',
    TITLE_PREFIX: '[Metrics]',
  },
};
