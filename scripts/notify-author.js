#!/usr/bin/env node

const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { formatAsBlockquote, formatModerators, getSeverityLabel, isModerationRequired, isAutoDelete } = require('./utils');
const { getNotificationMessages } = require('./templates');
const { deleteComment } = require('./github-api');
const { analyzeCommentWithAI } = require('./ai-analyzer');
const { recordMetrics } = require('./metrics');

/**
 * GitHub Actions에서 호출되거나 로컬에서 테스트할 수 있는 알림 스크립트
 *
 * 사용법:
 * - GitHub Actions: context와 github 객체를 인자로 받음
 * - 로컬 테스트: ISSUE_NUMBER 환경변수 사용
 *   예: ISSUE_NUMBER=1 node scripts/notify-author.js
 */

async function notifyAuthor(context, github) {
  console.log('=== Starting Author Notification Process ===');

  // Issue 제목 확인
  const issueTitle = context.payload.issue.title;
  console.log('Issue Title:', issueTitle);

  // utterances는 페이지 URL을 Issue 제목으로 사용
  // 예: "https://oliveyoung.tech/blog/2025-07-22-what-is-MFE-part1/"

  // 날짜-slug 패턴 추출 (YYYY-MM-DD-slug 또는 YYYY-MM-DD/slug)
  const match = issueTitle.match(config.POST_PATTERN);

  if (!match) {
    console.log('❌ Could not extract post info from issue title');
    console.log('Expected format: YYYY-MM-DD-slug or YYYY-MM-DD/slug');
    return;
  }

  const [_, postDate, postSlug] = match;
  console.log('✅ Extracted - Date:', postDate, 'Slug:', postSlug);

  // tech-blog에서 해당 포스트 찾기
  // 로컬 테스트: ../ 경로 먼저 확인
  // GitHub Actions: 'tech-blog' 사용 (체크아웃된 경로)
  let techBlogPath = process.env.TECH_BLOG_PATH;

  if (!techBlogPath) {
    // 환경변수가 없으면 로컬 환경 우선 확인
    if (!process.env.GITHUB_ACTIONS && fs.existsSync('../oliveyoung-tech-blog')) {
      techBlogPath = '../oliveyoung-tech-blog';
    } else {
      techBlogPath = 'tech-blog';
    }
  }

  const dateFolder = `${techBlogPath}/contents/${postDate}`;

  console.log('📁 Tech blog path:', techBlogPath);
  console.log('📁 Looking for post in:', dateFolder);

  if (!fs.existsSync(dateFolder)) {
    console.log('❌ Post directory not found:', dateFolder);
    return;
  }

  // 해당 날짜 폴더의 .md 파일 찾기
  const mdFiles = fs.readdirSync(dateFolder).filter(f => f.endsWith('.md'));

  if (mdFiles.length === 0) {
    console.log('❌ No markdown files found in', dateFolder);
    return;
  }

  console.log('📄 Found markdown files:', mdFiles);

  // 첫 번째 .md 파일 읽기
  const postPath = path.join(dateFolder, mdFiles[0]);
  const postContent = fs.readFileSync(postPath, 'utf8');

  // frontmatter에서 writer 추출
  const frontmatterMatch = postContent.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    console.log('❌ No frontmatter found in post');
    return;
  }

  const frontmatter = yaml.load(frontmatterMatch[1]);
  const writerId = frontmatter.writer;

  // 포스트 언어 감지 (기본값: 한국어)
  let postLanguage = (frontmatter.language || 'ko').toLowerCase();

  // 언어 검증
  if (!['ko', 'en'].includes(postLanguage)) {
    console.log(`⚠️  Unknown language: ${postLanguage}, defaulting to Korean`);
    postLanguage = 'ko';
  }

  if (!writerId) {
    console.log('❌ No writer field in frontmatter');
    return;
  }

  console.log('✅ Post writer ID:', writerId);
  console.log('✅ Post language:', postLanguage === 'ko' ? 'Korean' : 'English');

  // member.yaml에서 작성자 정보 찾기
  const memberYamlPath = `${techBlogPath}/src/templates/Post/member.yaml`;

  if (!fs.existsSync(memberYamlPath)) {
    console.log('❌ member.yaml not found at', memberYamlPath);
    return;
  }

  const memberYaml = fs.readFileSync(memberYamlPath, 'utf8');
  const members = yaml.load(memberYaml);

  const author = members.find(m => m && m.id === writerId);

  if (!author) {
    console.log('❌ Author not found in member.yaml for ID:', writerId);
    return;
  }

  console.log('✅ Author found:', author.name);

  // GitHub username 확인
  const hasGithubId = !!author.github;

  if (!hasGithubId) {
    console.log('⚠️  No GitHub username found for author:', author.name);
    console.log('⚠️  Will create fallback notification for moderators');
  } else {
    console.log('✅ Author GitHub username:', author.github);
  }

  // 댓글 작성자 정보
  const commenter = context.payload.comment?.user.login || context.payload.issue.user.login;
  const commentUrl = context.payload.comment?.html_url || context.payload.issue.html_url;
  const commentBody = context.payload.comment?.body || context.payload.issue.body || '';
  const isNewIssue = !context.payload.comment; // 첫 댓글인지 확인

  // AI 댓글 분석
  const aiAnalysis = await analyzeCommentWithAI(commentBody, frontmatter.title, postLanguage);

  const { MODERATORS } = config;

  // level 4+ 악성 댓글 자동 삭제
  const commentNodeId = context.payload.comment?.node_id || context.payload.issue.node_id;
  const isComment = !!context.payload.comment;
  let commentDeleted = false;

  console.log(`📍 Comment type: ${isComment ? 'Reply comment' : 'Issue body (first comment)'}`);
  console.log(`📍 Node ID: ${commentNodeId}`);

  if (isAutoDelete(aiAnalysis)) {
    console.log(`⚠️  High toxicity detected (level ${aiAnalysis.toxicity_level})`);

    if (!isComment) {
      console.log('⚠️  WARNING: This is an Issue body, not a reply comment. Issue bodies cannot be deleted via API.');
      console.log('⚠️  Please delete it manually or wait for a reply comment.');
    } else {
      // Level 4+: 즉시 삭제 (증거는 알림 Issue에 보존됨)
      console.log(`🗑️  Level ${aiAnalysis.toxicity_level} detected - Attempting to DELETE comment permanently...`);
      commentDeleted = await deleteComment(github, context);
      console.log(`📍 Delete result: ${commentDeleted ? 'SUCCESS' : 'FAILED'}`);
    }
  }

  // toxicity level에 따라 알림 메시지 분기
  let notificationTitle, notificationBody, labels;
  const emoji = isNewIssue ? '🎉' : '💬';
  const action = isNewIssue ? '새로운 댓글이 달렸습니다' : '댓글이 추가되었습니다';

  // GitHub ID 누락 시 Fallback 알림 생성
  if (!hasGithubId) {
    console.log('⚠️  Creating fallback notification for missing GitHub ID');

    let aiSection = '';
    if (aiAnalysis) {
      const toxicityWarning = isModerationRequired(aiAnalysis)
        ? `\n\n⚠️ **Toxicity Level ${aiAnalysis.toxicity_level}** - ${postLanguage === 'en' ? 'Moderation may be required' : '모더레이션이 필요할 수 있습니다'}.\n**${postLanguage === 'en' ? 'Issues' : '문제점'}:** ${aiAnalysis.concerns?.join(', ') || 'N/A'}`
        : '';

      aiSection = `

---

### 🤖 ${postLanguage === 'en' ? 'AI Comment Analysis' : 'AI 댓글 분석'}

**${postLanguage === 'en' ? 'Category' : '분류'}:** ${aiAnalysis.category}
**${postLanguage === 'en' ? 'Summary' : '요약'}:** ${aiAnalysis.summary}${toxicityWarning}

**${postLanguage === 'en' ? 'Suggested Responses' : '추천 답변'}:**
${aiAnalysis.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n\n')}`;
    }

    const messages = getNotificationMessages(postLanguage, 'fallback', {
      title: frontmatter.title,
      commentUrl,
      authorName: author.name,
      writerId,
      commenter,
      commentBody: formatAsBlockquote(commentBody),
      aiSection,
      moderators: formatModerators(MODERATORS)
    });

    notificationTitle = messages.title;
    notificationBody = messages.body;
    labels = ['notification', 'missing-github-id', 'action-required'];

  } else if (isModerationRequired(aiAnalysis)) {
    // Level 3+ 모더레이션 필요 알림
    const toxicityEmoji = isAutoDelete(aiAnalysis) ? '🚨' : '⚠️';
    const severityLabel = getSeverityLabel(aiAnalysis.toxicity_level);
    const deletedMessage = commentDeleted
      ? `🗑️ **${postLanguage === 'en' ? 'This comment has been automatically deleted.' : '이 댓글은 자동으로 삭제되었습니다.'}** (${postLanguage === 'en' ? 'Evidence preserved in this notification' : '증거는 이 알림에 보존됨'})\n`
      : '';

    const suggestions = isAutoDelete(aiAnalysis)
      ? (postLanguage === 'en'
        ? `**1️⃣ Immediate Action (Recommended)**
- ${commentDeleted ? '✅ Comment already deleted automatically' : '⚠️ Deletion recommended'}
- Consider blocking user if repeated
- Review GitHub Abuse Report for severe cases

**2️⃣ Additional Monitoring**
- Check other comments from same user
- Analyze patterns and keep records`
        : `**1️⃣ 즉시 조치 (권장)**
- ${commentDeleted ? '✅ 댓글이 이미 자동 삭제되었습니다' : '⚠️ 댓글 삭제를 권장합니다'}
- 반복되는 경우 사용자 차단 고려
- 심각한 경우 GitHub Abuse Report 검토

**2️⃣ 추가 모니터링**
- 동일 사용자의 다른 댓글 확인
- 패턴 분석 및 기록 보관`)
      : (postLanguage === 'en'
        ? `**1️⃣ Careful Response**
- Address only technical points briefly
- Maintain professional and neutral tone
- Don't escalate to argument

**2️⃣ Guideline Notice**
- "We welcome constructive feedback"
- Provide community guidelines link

**3️⃣ Ignore**
- Hide comment and don't respond`
        : `**1️⃣ 신중한 답변**
- 기술적 논점만 간단히 응대
- 전문적이고 중립적인 톤 유지
- 논쟁으로 확대하지 않기

**2️⃣ 가이드라인 안내**
- "건설적인 피드백을 환영합니다"
- 커뮤니티 가이드라인 링크 제공

**3️⃣ 무시**
- 댓글 숨김 후 답변하지 않기`);

    const messages = getNotificationMessages(postLanguage, 'toxic', {
      emoji: toxicityEmoji,
      title: frontmatter.title,
      commentUrl,
      commenter,
      toxicityLevel: aiAnalysis.toxicity_level,
      severityLabel,
      concerns: aiAnalysis.concerns?.join(', ') || 'N/A',
      deletedMessage,
      commentBody: formatAsBlockquote(commentBody),
      category: aiAnalysis.category,
      summary: aiAnalysis.summary,
      suggestions,
      moderators: formatModerators(MODERATORS)
    });

    notificationTitle = messages.title;
    notificationBody = messages.body;
    labels = ['notification', 'moderation', isAutoDelete(aiAnalysis) ? 'urgent' : 'warning'];

  } else {
    // 일반 알림 (toxicity level 0-2)
    let aiSection = '';
    if (aiAnalysis) {
      aiSection = `

---

### 🤖 ${postLanguage === 'en' ? 'AI Comment Analysis' : 'AI 댓글 분석'}

**${postLanguage === 'en' ? 'Category' : '분류'}:** ${aiAnalysis.category}
**${postLanguage === 'en' ? 'Summary' : '요약'}:** ${aiAnalysis.summary}

**${postLanguage === 'en' ? 'Suggested Responses' : '추천 답변'}:**
${aiAnalysis.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n\n')}`;
    }

    const actionText = isNewIssue
      ? (postLanguage === 'en' ? 'a new comment was posted' : '새로운 댓글이 달렸습니다')
      : (postLanguage === 'en' ? 'a comment was added' : '댓글이 추가되었습니다');

    const messages = getNotificationMessages(postLanguage, 'normal', {
      emoji,
      github: author.github,
      action: actionText,
      commentUrl,
      title: frontmatter.title,
      commenter,
      commentBody: formatAsBlockquote(commentBody),
      aiSection
    });

    notificationTitle = messages.title;
    notificationBody = messages.body;
    labels = ['notification', 'comment'];
  }

  // oliveyoung-tech-blog 저장소에서 기존 알림 Issue 찾기
  const techBlogOwner = config.GITHUB.OWNER;
  const techBlogRepo = config.GITHUB.REPO;

  console.log('🔍 Checking for existing notification issue...');

  // 알림 Issue 생성을 위한 별도 Octokit 인스턴스 (TECH_BLOG_ACCESS_TOKEN 사용)
  // github 객체는 기본 GITHUB_TOKEN을 사용하므로 다른 조직에 접근 불가
  const { Octokit } = require('@octokit/rest');
  const techBlogToken = process.env.TECH_BLOG_ACCESS_TOKEN;

  if (!techBlogToken) {
    console.error('❌ TECH_BLOG_ACCESS_TOKEN not found');
    throw new Error('TECH_BLOG_ACCESS_TOKEN is required for creating notification issues');
  }

  const techBlogGithub = new Octokit({ auth: techBlogToken });

  // 같은 포스트에 대한 알림 Issue 검색
  const searchQuery = `repo:${techBlogOwner}/${techBlogRepo} is:issue is:open label:notification "${frontmatter.title}"`;

  try {
    const { data: searchResults } = await techBlogGithub.rest.search.issuesAndPullRequests({
      q: searchQuery
    });

    if (searchResults.total_count > 0) {
      // 기존 Issue가 있으면 댓글 추가
      const existingIssue = searchResults.items[0];
      console.log('✅ Found existing notification issue:', existingIssue.html_url);

      let newCommentBody;

      if (isModerationRequired(aiAnalysis)) {
        // 모더레이션 필요 댓글
        const toxicityEmoji = isAutoDelete(aiAnalysis) ? '🚨' : '⚠️';
        const severityLabel = getSeverityLabel(aiAnalysis.toxicity_level);

        newCommentBody = `${toxicityEmoji} **부적절한 댓글이 추가되었습니다**: [보기](${commentUrl})

**댓글 작성자:** ${commenter}
**위험도:** Level ${aiAnalysis.toxicity_level} (${severityLabel})
**문제점:** ${aiAnalysis.concerns?.join(', ') || 'N/A'}

### 📋 댓글 내용
> ${formatAsBlockquote(commentBody)}

${commentDeleted ? '🗑️ **이 댓글은 자동으로 삭제되었습니다.** (증거는 이 알림에 보존됨)' : ''}

### 🤖 AI 분석
**분류:** ${aiAnalysis.category} | **감정:** ${aiAnalysis.sentiment}
**요약:** ${aiAnalysis.summary}

${aiAnalysis.moderation_advice ? `**조언:** ${aiAnalysis.moderation_advice}` : ''}

---
**관리자:** ${formatModerators(MODERATORS)}`;

        // 기존 Issue에 moderation 라벨 추가
        const currentLabels = existingIssue.labels.map(l => typeof l === 'string' ? l : l.name);
        const newLabels = [...new Set([...currentLabels, 'moderation', isAutoDelete(aiAnalysis) ? 'urgent' : 'warning'])];

        await techBlogGithub.rest.issues.update({
          owner: techBlogOwner,
          repo: techBlogRepo,
          issue_number: existingIssue.number,
          labels: newLabels
        });

      } else {
        // 일반 댓글
        let aiSection = '';
        if (aiAnalysis) {
          aiSection = `

---

### 🤖 AI 댓글 분석

**분류:** ${aiAnalysis.category}
**요약:** ${aiAnalysis.summary}

**추천 답변:**
${aiAnalysis.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n\n')}`;
        }

        newCommentBody = `${emoji} 새로운 댓글이 추가되었습니다: [보기](${commentUrl})

**댓글 작성자:** ${commenter}

**댓글 내용:**
> ${formatAsBlockquote(commentBody)}${aiSection}`;
      }

      await techBlogGithub.rest.issues.createComment({
        owner: techBlogOwner,
        repo: techBlogRepo,
        issue_number: existingIssue.number,
        body: newCommentBody
      });

      console.log('✅ Comment added to existing issue #' + existingIssue.number);
    } else {
      // 기존 Issue가 없으면 새로 생성
      console.log('📝 No existing issue found, creating new one...');

      await techBlogGithub.rest.issues.create({
        owner: techBlogOwner,
        repo: techBlogRepo,
        title: notificationTitle,
        body: notificationBody,
        labels: labels
      });

      console.log('✅ Notification issue created successfully in', `${techBlogOwner}/${techBlogRepo}`);
    }

    // 메트릭 기록
    await recordMetrics(techBlogGithub, {
      postTitle: frontmatter.title,
      commenter,
      notified: hasGithubId,
      category: aiAnalysis?.category || null,
      sentiment: aiAnalysis?.sentiment || null,
      toxicityLevel: aiAnalysis?.toxicity_level ?? 0,
      commentDeleted,
    });

    console.log('✅ Author @' + author.github + ' will be notified');
    console.log('=== Process Completed ===');
  } catch (error) {
    console.error('❌ Error handling notification:', error.message);
    throw error;
  }
}

// 로컬 테스트를 위한 메인 함수
async function main() {
  // 로컬 테스트 모드인지 확인
  if (process.env.ISSUE_NUMBER && !process.env.GITHUB_ACTIONS) {
    console.log('🧪 Running in local test mode');

    const { Octokit } = require('@octokit/rest');
    const issueNumber = parseInt(process.env.ISSUE_NUMBER);

    // tech-blog-comment는 public이므로 토큰 없이 읽기
    const octokitPublic = new Octokit();

    // oliveyoung-tech-blog에 Issue 생성용 (토큰 필요)
    let octokitAuth = null;
    const token = process.env.TECH_BLOG_ACCESS_TOKEN || process.env.GITHUB_TOKEN;
    if (token) {
      octokitAuth = new Octokit({ auth: token.trim() });
      console.log('✅ TECH_BLOG_ACCESS_TOKEN configured');
    } else {
      console.log('⚠️  TECH_BLOG_ACCESS_TOKEN not set (dry-run mode)');
    }

    // 현재 저장소 정보 (tech-blog-comment)
    const owner = 'oy-techblog';
    const repo = 'tech-blog-comment';

    console.log(`Fetching issue #${issueNumber} from ${owner}/${repo}`);

    // Issue 정보 가져오기 (토큰 없이)
    const { data: issue } = await octokitPublic.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber
    });

    // 최근 댓글 가져오기 (토큰 없이)
    const { data: comments } = await octokitPublic.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 1,
      sort: 'created',
      direction: 'desc'
    });

    // Context 객체 생성 (GitHub Actions의 context와 유사하게)
    const context = {
      payload: {
        issue: issue,
        comment: comments.length > 0 ? comments[0] : null
      },
      repo: {
        owner,
        repo
      }
    };

    // GitHub API 객체
    const github = {
      rest: {
        search: {
          issuesAndPullRequests: async ({ q }) => {
            console.log('\n🔍 Searching for existing issues...');
            console.log('Query:', q);

            if (octokitAuth) {
              return await octokitAuth.rest.search.issuesAndPullRequests({ q });
            } else {
              // Dry-run: 기존 Issue가 없다고 가정
              console.log('⚠️  Dry-run mode: Assuming no existing issues');
              return { data: { total_count: 0, items: [] } };
            }
          }
        },
        issues: {
          create: async ({ owner, repo, title, body, labels }) => {
            console.log('\n📝 Would create issue in', `${owner}/${repo}`);
            console.log('---');
            console.log('Title:', title);
            console.log('Labels:', labels);
            console.log('\nBody:');
            console.log(body);
            console.log('---');

            // 실제로 Issue를 생성하려면 TECH_BLOG_ACCESS_TOKEN 설정 후 ENABLE_NOTIFICATION=true
            if (octokitAuth && process.env.ENABLE_NOTIFICATION === 'true') {
              console.log('\n✅ Creating issue on GitHub...');
              return await octokitAuth.rest.issues.create({
                owner,
                repo,
                title,
                body,
                labels
              });
            } else {
              console.log('\n⚠️  Dry-run mode: Issue not created.');
              if (!octokitAuth) {
                console.log('Missing: TECH_BLOG_ACCESS_TOKEN (required for creating issues in oliveyoung-tech-blog)');
              }
              if (process.env.ENABLE_NOTIFICATION !== 'true') {
                console.log('Missing: ENABLE_NOTIFICATION=true');
              }
            }
          },
          createComment: async ({ owner, repo, issue_number, body }) => {
            console.log('\n💬 Would add comment to', `${owner}/${repo}#${issue_number}`);
            console.log('---');
            console.log(body);
            console.log('---');

            if (octokitAuth && process.env.ENABLE_NOTIFICATION === 'true') {
              console.log('\n✅ Adding comment on GitHub...');
              return await octokitAuth.rest.issues.createComment({
                owner,
                repo,
                issue_number,
                body
              });
            } else {
              console.log('\n⚠️  Dry-run mode: Comment not created.');
            }
          }
        }
      }
    };

    await notifyAuthor(context, github);
  } else {
    console.log('This script should be called from GitHub Actions or with ISSUE_NUMBER env var');
  }
}

// GitHub Actions에서 호출할 수 있도록 export
module.exports = { notifyAuthor };

// 직접 실행될 때만 main 함수 호출
if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}
