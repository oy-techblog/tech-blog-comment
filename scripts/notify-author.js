#!/usr/bin/env node

const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * GitHub Actions에서 호출되거나 로컬에서 테스트할 수 있는 알림 스크립트
 *
 * 사용법:
 * - GitHub Actions: context와 github 객체를 인자로 받음
 * - 로컬 테스트: ISSUE_NUMBER 환경변수 사용
 *   예: ISSUE_NUMBER=1 node scripts/notify-author.js
 */

/**
 * GitHub GraphQL API를 사용하여 댓글 숨김 처리 (Level 4용)
 */
async function hideComment(github, commentNodeId) {
  try {
    console.log('🚫 Hiding toxic comment...');

    const mutation = `
      mutation {
        minimizeComment(input: {
          subjectId: "${commentNodeId}",
          classifier: SPAM
        }) {
          minimizedComment {
            isMinimized
            minimizedReason
          }
        }
      }
    `;

    const result = await github.graphql(mutation);

    if (result.minimizedComment?.isMinimized) {
      console.log('✅ Comment successfully hidden');
      return true;
    } else {
      console.log('⚠️  Comment hide request sent but status unknown');
      return false;
    }
  } catch (error) {
    console.error('❌ Failed to hide comment:', error.message);
    // 숨김 실패해도 알림은 계속 진행
    return false;
  }
}

/**
 * GitHub REST API를 사용하여 댓글 완전 삭제 (Level 5용)
 */
async function deleteComment(github, context) {
  try {
    console.log('🗑️  Deleting severely toxic comment...');

    // Issue comment인 경우에만 삭제 가능
    if (!context.payload.comment) {
      console.log('⚠️  Cannot delete Issue body. Only reply comments can be deleted.');
      return false;
    }

    const commentId = context.payload.comment.id;
    const owner = context.repo.owner;
    const repo = context.repo.repo;

    await github.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: commentId
    });

    console.log('✅ Comment successfully deleted');
    return true;
  } catch (error) {
    console.error('❌ Failed to delete comment:', error.message);
    // 삭제 실패해도 알림은 계속 진행
    return false;
  }
}

/**
 * Gemini API를 사용하여 댓글 분석 및 추천 답변 생성
 */
async function analyzeCommentWithAI(commentBody, postTitle) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.log('⚠️  GEMINI_API_KEY not set, skipping AI analysis');
    return null;
  }

  try {
    console.log('🤖 Analyzing comment with Gemini AI...');

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const prompt = `당신은 기술 블로그의 댓글을 분석하고 모더레이션하는 AI 어시스턴트입니다.

블로그 포스트 제목: "${postTitle}"

댓글 내용:
"""
${commentBody}
"""

다음 작업을 수행해주세요:

1. **댓글 톤 분석**
   - sentiment: positive(긍정적) / neutral(중립적) / negative(부정적) / hostile(적대적)
   - toxicity_level: 0-5 점수 부여
     * 0: 매우 건전한 댓글
     * 1: 건전하며 건설적
     * 2: 부정적이지만 예의 있음
     * 3: 무례하거나 비꼬는 표현 포함
     * 4: 욕설, 비하, 인신공격 포함
     * 5: 심각한 위협, 혐오 표현 포함
   - requires_moderation: 모더레이션이 필요한지 여부 (toxicity_level >= 3이면 true)

2. **문제 요소 탐지** (해당되는 것만 배열에 포함)
   - profanity: 욕설/비속어 사용
   - personal_attack: 작성자나 특정인에 대한 인신공격
   - trolling: 악의적 도발이나 분란 조장
   - disrespectful: 무례하고 비하적인 표현
   - hate_speech: 혐오 표현
   - spam: 스팸이나 관련 없는 광고
   - off_topic: 주제와 무관한 내용

3. **댓글 분류**
   - Question: 기술적 질문
   - Feedback: 건설적 피드백/제안
   - Appreciation: 칭찬이나 감사
   - Discussion: 기술적 논의
   - Criticism: 날카로운 비판 (예의는 지킴)
   - Hostile: 공격적이거나 모욕적인 댓글
   - Spam: 스팸/광고

4. **모더레이션 조언** (toxicity_level >= 3일 때만)
   - 어떤 문제가 있는지
   - 권장 조치 방법

5. **추천 답변**: 댓글에 적절한 답변 2-3가지 제안
   - 건전한 댓글: 친절하고 전문적인 답변
   - 공격적 댓글: 간단한 가이드라인 안내 또는 무시 권장

응답 형식 (JSON):
{
  "category": "Question/Feedback/Appreciation/Discussion/Criticism/Hostile/Spam",
  "sentiment": "positive/neutral/negative/hostile",
  "toxicity_level": 0-5,
  "requires_moderation": true/false,
  "concerns": ["profanity", "personal_attack", ...],
  "summary": "댓글 요약 (한 문장)",
  "moderation_advice": "모더레이션 조언 (toxicity_level >= 3일 때만)",
  "suggestions": [
    "추천 답변 1",
    "추천 답변 2",
    "추천 답변 3"
  ]
}`;

    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();

    // JSON 파싱 (코드 블록 제거)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);
      console.log('✅ AI analysis completed');
      console.log('   Category:', analysis.category);
      console.log('   Sentiment:', analysis.sentiment);
      console.log('   Toxicity Level:', analysis.toxicity_level);
      console.log('   Requires Moderation:', analysis.requires_moderation);
      if (analysis.concerns && analysis.concerns.length > 0) {
        console.log('   Concerns:', analysis.concerns.join(', '));
      }
      return analysis;
    } else {
      console.log('⚠️  Could not parse AI response');
      return null;
    }
  } catch (error) {
    console.error('❌ AI analysis failed:', error.message);
    return null;
  }
}

async function notifyAuthor(context, github) {
  console.log('=== Starting Author Notification Process ===');

  // Issue 제목 확인
  const issueTitle = context.payload.issue.title;
  console.log('Issue Title:', issueTitle);

  // utterances는 페이지 URL을 Issue 제목으로 사용
  // 예: "https://oliveyoung.tech/blog/2025-07-22-what-is-MFE-part1/"

  // 날짜-slug 패턴 추출 (YYYY-MM-DD-slug 또는 YYYY-MM-DD/slug)
  const postPattern = /(\d{4}-\d{2}-\d{2})[-\/]([^\/\s?#]+)/;
  const match = issueTitle.match(postPattern);

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

  if (!writerId) {
    console.log('❌ No writer field in frontmatter');
    return;
  }

  console.log('✅ Post writer ID:', writerId);

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
  if (!author.github) {
    console.log('⚠️  No GitHub username found for author:', author.name);
    console.log('Please add "github: username" field to member.yaml');
    return;
  }

  console.log('✅ Author GitHub username:', author.github);

  // 댓글 작성자 정보
  const commenter = context.payload.comment?.user.login || context.payload.issue.user.login;
  const commentUrl = context.payload.comment?.html_url || context.payload.issue.html_url;
  const commentBody = context.payload.comment?.body || context.payload.issue.body || '';
  const isNewIssue = !context.payload.comment; // 첫 댓글인지 확인

  // AI 댓글 분석
  const aiAnalysis = await analyzeCommentWithAI(commentBody, frontmatter.title);

  // 관리자 계정
  const MODERATORS = ['oy-ladygain', 'oy-0nlyoung7'];

  // level 4+ 악성 댓글 자동 삭제
  const commentNodeId = context.payload.comment?.node_id || context.payload.issue.node_id;
  const isComment = !!context.payload.comment;
  let commentDeleted = false;

  console.log(`📍 Comment type: ${isComment ? 'Reply comment' : 'Issue body (first comment)'}`);
  console.log(`📍 Node ID: ${commentNodeId}`);

  if (aiAnalysis && aiAnalysis.toxicity_level >= 4) {
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

  if (aiAnalysis && aiAnalysis.toxicity_level >= 3) {
    // Level 3+ 모더레이션 필요 알림
    const toxicityEmoji = aiAnalysis.toxicity_level >= 4 ? '🚨' : '⚠️';
    const severityLabel = aiAnalysis.toxicity_level >= 4 ? 'High' : 'Medium';

    notificationTitle = `${toxicityEmoji} [모더레이션 필요] ${frontmatter.title || 'Untitled'} - 부적절한 댓글`;

    notificationBody = `${toxicityEmoji} **모더레이션이 필요한 댓글이 감지되었습니다**

**포스트:** [${frontmatter.title || 'Untitled'}](${commentUrl})
**댓글 작성자:** ${commenter}
**위험도:** Level ${aiAnalysis.toxicity_level} (${severityLabel})
**문제점:** ${aiAnalysis.concerns?.join(', ') || 'N/A'}

### 📋 댓글 내용
> ${commentBody.split('\n').join('\n> ')}

${commentDeleted ? '🗑️ **이 댓글은 자동으로 삭제되었습니다.** (증거는 이 알림에 보존됨)\n' : ''}
---

### 🤖 AI 분석 결과

**분류:** ${aiAnalysis.category}
**감정:** ${aiAnalysis.sentiment}
**요약:** ${aiAnalysis.summary}

**모더레이션 조언:**
${aiAnalysis.moderation_advice || 'N/A'}

---

### 💡 권장 조치

${aiAnalysis.toxicity_level >= 4 ? `
**1️⃣ 즉시 조치 (권장)**
- ${commentHidden ? '✅ 댓글이 이미 자동 숨김 처리되었습니다' : '⚠️ 댓글 숨김 처리를 권장합니다'}
- 반복되는 경우 사용자 차단 고려
- 심각한 경우 GitHub Abuse Report 검토

**2️⃣ 답변하는 경우 (비권장)**
- 간단히 커뮤니티 가이드라인만 안내
- 감정적 대응 피하기

**3️⃣ 무시 (가능)**
- 답변하지 않고 숨김 처리만 유지
` : `
**1️⃣ 신중한 답변**
- 기술적 논점만 간단히 응대
- 전문적이고 중립적인 톤 유지
- 논쟁으로 확대하지 않기

**2️⃣ 가이드라인 안내**
- "건설적인 피드백을 환영합니다"
- 커뮤니티 가이드라인 링크 제공

**3️⃣ 무시**
- 댓글 숨김 후 답변하지 않기
`}

### 📚 참고 자료
- [커뮤니티 가이드라인](https://github.com/oy-alldev/oliveyoung-tech-blog/blob/main/COMMUNITY_GUIDELINES.md)
- [댓글 숨김 방법](https://docs.github.com/en/communities/moderating-comments-and-conversations/managing-disruptive-comments#hiding-a-comment)
- [사용자 차단 방법](https://docs.github.com/en/communities/maintaining-your-safety-on-github/blocking-a-user-from-your-organization)

---

**작성자:** @${author.github}
**관리자:** ${MODERATORS.map(m => `@${m}`).join(', ')}

_이 알림은 GitHub Actions에 의해 자동 생성되었습니다_`;

    labels = ['notification', 'moderation', aiAnalysis.toxicity_level >= 4 ? 'urgent' : 'warning'];

  } else {
    // 일반 알림 (toxicity level 0-2)
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

    notificationTitle = `[알림] ${frontmatter.title || 'Untitled'} - 새 댓글`;
    notificationBody = `${emoji} @${author.github} 님, 작성하신 포스트에 [${action}](${commentUrl})!

**포스트:** ${frontmatter.title || 'Untitled'}
**댓글 작성자:** ${commenter}

**댓글 내용:**
> ${commentBody.split('\n').join('\n> ')}${aiSection}

---
_이 알림은 GitHub Actions에 의해 자동 생성되었습니다_`;

    labels = ['notification', 'comment'];
  }

  // oliveyoung-tech-blog 저장소에서 기존 알림 Issue 찾기
  const techBlogOwner = process.env.TECH_BLOG_OWNER || 'oy-alldev';
  const techBlogRepo = process.env.TECH_BLOG_REPO || 'oliveyoung-tech-blog';

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

      if (aiAnalysis && aiAnalysis.toxicity_level >= 3) {
        // 모더레이션 필요 댓글
        const toxicityEmoji = aiAnalysis.toxicity_level >= 4 ? '🚨' : '⚠️';
        const severityLabel = aiAnalysis.toxicity_level >= 4 ? 'High' : 'Medium';

        newCommentBody = `${toxicityEmoji} **부적절한 댓글이 추가되었습니다**: [보기](${commentUrl})

**댓글 작성자:** ${commenter}
**위험도:** Level ${aiAnalysis.toxicity_level} (${severityLabel})
**문제점:** ${aiAnalysis.concerns?.join(', ') || 'N/A'}

### 📋 댓글 내용
> ${commentBody.split('\n').join('\n> ')}

${commentDeleted ? '🗑️ **이 댓글은 자동으로 삭제되었습니다.** (증거는 이 알림에 보존됨)' : ''}

### 🤖 AI 분석
**분류:** ${aiAnalysis.category} | **감정:** ${aiAnalysis.sentiment}
**요약:** ${aiAnalysis.summary}

${aiAnalysis.moderation_advice ? `**조언:** ${aiAnalysis.moderation_advice}` : ''}

---
**관리자:** ${MODERATORS.map(m => `@${m}`).join(', ')}`;

        // 기존 Issue에 moderation 라벨 추가
        const currentLabels = existingIssue.labels.map(l => typeof l === 'string' ? l : l.name);
        const newLabels = [...new Set([...currentLabels, 'moderation', aiAnalysis.toxicity_level >= 4 ? 'urgent' : 'warning'])];

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
> ${commentBody.split('\n').join('\n> ')}${aiSection}`;
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
