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

    const prompt = `당신은 기술 블로그의 댓글을 분석하고 적절한 답변을 추천하는 AI 어시스턴트입니다.

블로그 포스트 제목: "${postTitle}"

댓글 내용:
"""
${commentBody}
"""

다음 작업을 수행해주세요:

1. **댓글 분류**: 이 댓글의 유형을 판단하세요.
   - 질문 (Question): 기술적 질문이나 궁금한 점
   - 피드백 (Feedback): 의견, 제안, 개선사항
   - 감사 (Appreciation): 칭찬이나 감사 표현
   - 토론 (Discussion): 기술적 논의나 의견 공유
   - 기타 (Other): 위 카테고리에 속하지 않는 경우

2. **추천 답변**: 작성자가 사용할 수 있는 적절한 답변을 2-3가지 제안해주세요.
   - 친절하고 전문적인 톤 유지
   - 기술 블로그 커뮤니티에 적합한 답변
   - 각 답변은 2-3문장 정도로 간결하게

응답 형식 (JSON):
{
  "category": "댓글 유형 (Question/Feedback/Appreciation/Discussion/Other)",
  "summary": "댓글 요약 (한 문장)",
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

  // 알림 메시지 작성
  const emoji = isNewIssue ? '🎉' : '💬';
  const action = isNewIssue ? '새로운 댓글이 달렸습니다' : '댓글이 추가되었습니다';

  // AI 분석 결과 포맷팅
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

  const notificationTitle = `[알림] ${frontmatter.title || 'Untitled'} - 새 댓글`;
  const notificationBody = `${emoji} @${author.github} 님, 작성하신 포스트에 [${action}](${commentUrl})!

**포스트:** ${frontmatter.title || 'Untitled'}
**댓글 작성자:** ${commenter}

**댓글 내용:**
> ${commentBody.split('\n').join('\n> ')}${aiSection}

---
_This notification was automatically generated by GitHub Actions_`;

  // oliveyoung-tech-blog 저장소에서 기존 알림 Issue 찾기
  const techBlogOwner = process.env.TECH_BLOG_OWNER || 'oy-alldev';
  const techBlogRepo = process.env.TECH_BLOG_REPO || 'oliveyoung-tech-blog';

  console.log('🔍 Checking for existing notification issue...');

  // 같은 포스트에 대한 알림 Issue 검색
  const searchQuery = `repo:${techBlogOwner}/${techBlogRepo} is:issue is:open label:notification "${frontmatter.title}"`;

  try {
    const { data: searchResults } = await github.rest.search.issuesAndPullRequests({
      q: searchQuery
    });

    if (searchResults.total_count > 0) {
      // 기존 Issue가 있으면 댓글 추가
      const existingIssue = searchResults.items[0];
      console.log('✅ Found existing notification issue:', existingIssue.html_url);

      const newCommentBody = `${emoji} 새로운 댓글이 추가되었습니다: [보기](${commentUrl})

**댓글 작성자:** ${commenter}

**댓글 내용:**
> ${commentBody.split('\n').join('\n> ')}${aiSection}`;

      await github.rest.issues.createComment({
        owner: techBlogOwner,
        repo: techBlogRepo,
        issue_number: existingIssue.number,
        body: newCommentBody
      });

      console.log('✅ Comment added to existing issue #' + existingIssue.number);
    } else {
      // 기존 Issue가 없으면 새로 생성
      console.log('📝 No existing issue found, creating new one...');

      await github.rest.issues.create({
        owner: techBlogOwner,
        repo: techBlogRepo,
        title: notificationTitle,
        body: notificationBody,
        labels: ['notification', 'comment']
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
    if (process.env.GITHUB_TOKEN) {
      const token = process.env.GITHUB_TOKEN.trim();
      octokitAuth = new Octokit({ auth: token });
      console.log('✅ GITHUB_TOKEN configured');
    } else {
      console.log('⚠️  GITHUB_TOKEN not set (dry-run mode)');
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

            // 실제로 Issue를 생성하려면 GITHUB_TOKEN 설정 후 ENABLE_NOTIFICATION=true
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
                console.log('Missing: GITHUB_TOKEN (required for creating issues in oliveyoung-tech-blog)');
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
