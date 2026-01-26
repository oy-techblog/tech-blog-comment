# Tech Blog Comment Notification System

블로그에 댓글이 달리면 포스트 작성자에게 자동으로 알림을 보내는 시스템입니다.

## 동작 방식

1. 사용자가 utterances를 통해 블로그에 댓글을 작성
2. utterances가 `oy-techblog/tech-blog-comment` 저장소에 Issue 생성
3. GitHub Actions가 트리거되어 포스트 작성자 찾기
   - tech-blog-comment의 Issue 제목에서 포스트 정보 추출
   - `oy-alldev/oliveyoung-tech-blog` 저장소에서 포스트 파일 찾기
   - member.yaml에서 작성자의 GitHub 계정 확인
4. **🤖 AI 댓글 분석** (선택 기능, GEMINI_API_KEY 설정 시)
   - Gemini AI를 사용하여 댓글 자동 분류
   - 적절한 답변 2-3가지 자동 생성
5. **`oy-alldev/oliveyoung-tech-blog` 저장소에 알림**
   - 해당 포스트에 대한 알림 Issue가 **이미 있으면** → 기존 Issue에 댓글 추가
   - 알림 Issue가 **없으면** → 새 Issue 생성 (작성자 멘션 포함)
   - AI 분석 결과 포함 (분류, 요약, 추천 답변)

## 로컬 테스트

### 1. 의존성 설치

```bash
npm install
```

### 2. oliveyoung-tech-blog 저장소 클론

스크립트는 oliveyoung-tech-blog 저장소의 파일들을 읽어야 합니다.

**권장: tech-blog-comment와 같은 레벨에 클론**

```bash
# tech-blog-comment의 상위 디렉토리로 이동
cd ..

# oliveyoung-tech-blog 클론
git clone https://github.com/oy-alldev/oliveyoung-tech-blog.git

# 다시 tech-blog-comment로 이동
cd tech-blog-comment
```

디렉토리 구조:
```
parent-directory/
├── tech-blog-comment/
└── oliveyoung-tech-blog/    # 자동으로 찾음
```

**다른 위치에 클론한 경우**

```bash
# 환경변수로 경로 지정
TECH_BLOG_PATH=/path/to/oliveyoung-tech-blog ISSUE_NUMBER=1 node scripts/notify-author.js
```

### 3. 스크립트 실행

**기본 실행 (읽기 전용, 토큰 불필요)**

tech-blog-comment는 public 저장소이므로 **토큰 없이도 읽기 가능**합니다:

```bash
# 간단하게 Issue 번호만 지정 (../oliveyoung-tech-blog를 자동으로 찾음)
ISSUE_NUMBER=1 node scripts/notify-author.js
```

이 모드에서는:
- ✅ Issue 정보를 **읽고** 작성자를 찾습니다 (토큰 불필요)
- ✅ 생성할 알림 메시지를 콘솔에 출력합니다
- ❌ 실제로 Issue를 **생성하지는 않습니다** (dry-run)

**실제 알림 Issue 생성 (토큰 필요)**

실제로 oliveyoung-tech-blog에 알림 Issue를 **생성**하려면 GitHub Personal Access Token이 필요합니다:

1. GitHub Settings > Developer settings > Personal access tokens > Tokens (classic)
2. Generate new token (classic)
3. 권한 선택: `repo` (전체)
4. 토큰 생성 후 안전하게 보관

```bash
# 토큰은 쓰기(Issue 생성)에만 사용됨
export GITHUB_TOKEN=your_github_token_here
export ENABLE_NOTIFICATION=true
export ISSUE_NUMBER=1

# AI 기능 테스트 (선택)
export GEMINI_API_KEY=your_gemini_api_key_here

# 스크립트 실행
node scripts/notify-author.js
```

**요약:**
- 🔓 **읽기 (oy-techblog/tech-blog-comment Issue)**: 토큰 불필요 (public 저장소)
- 🔒 **쓰기 (oy-alldev/oliveyoung-tech-blog Issue 생성)**: 토큰 필요 + `ENABLE_NOTIFICATION=true`
- 🤖 **AI 분석 (선택)**: `GEMINI_API_KEY` 설정 시 활성화

**두 개의 저장소:**
1. `oy-techblog/tech-blog-comment` - utterances가 댓글을 Issue로 저장 (읽기만, 토큰 불필요)
2. `oy-alldev/oliveyoung-tech-blog` - 알림 Issue 생성 (쓰기, 토큰 필요)

## 디렉토리 구조

**로컬 환경:**
```
parent-directory/
├── tech-blog-comment/
│   ├── .github/
│   │   └── workflows/
│   │       └── notify-author.yml    # GitHub Actions 워크플로우
│   ├── scripts/
│   │   └── notify-author.js         # 알림 로직 (분리된 스크립트)
│   ├── package.json
│   └── README.md
└── oliveyoung-tech-blog/            # 로컬: 자동으로 찾음
    ├── contents/                    # 블로그 포스트
    └── src/templates/Post/member.yaml  # 작성자 정보
```

**GitHub Actions 환경:**
```
workspace/
├── .github/workflows/notify-author.yml
├── scripts/notify-author.js
└── tech-blog/                       # Actions: 체크아웃된 경로
    ├── contents/
    └── src/templates/Post/member.yaml
```

## 설정 요구사항

### GitHub Secrets 설정

`tech-blog-comment` 저장소에 다음 Secret을 추가해야 합니다:

**설정 방법:**
1. GitHub에서 `tech-blog-comment` 저장소로 이동
2. Settings > Secrets and variables > Actions
3. "New repository secret" 클릭
4. 다음 Secret 추가:

**`TECH_BLOG_ACCESS_TOKEN`** (필수)
- **설명**: oliveyoung-tech-blog 저장소 접근 및 Issue 생성을 위한 Personal Access Token
- **생성 방법**:
  1. GitHub Settings > Developer settings > Personal access tokens > Tokens (classic)
  2. Generate new token (classic)
  3. 권한 선택: `repo` (전체)
  4. `oy-alldev` 조직에 대해 SSO 승인 (Configure SSO)
  5. 생성된 토큰을 Secret에 저장
- **용도**:
  1. oliveyoung-tech-blog 저장소 체크아웃 (포스트/member.yaml 읽기)
  2. oliveyoung-tech-blog 저장소에서 기존 알림 Issue 검색
  3. oliveyoung-tech-blog에 알림 Issue 생성 또는 댓글 추가

**`GEMINI_API_KEY`** (선택, AI 기능용)
- **설명**: Google Gemini API 키 (댓글 분석 및 답변 추천 기능)
- **생성 방법**:
  1. [Google AI Studio](https://aistudio.google.com/app/apikey) 접속
  2. "Create API Key" 클릭
  3. 생성된 API 키를 Secret에 저장
- **용도**:
  1. 댓글 자동 분류 (질문/피드백/감사/토론 등)
  2. AI 기반 답변 추천 (2-3가지 답변 제안)
- **참고**: API 키가 없어도 알림 시스템은 정상 작동하며, AI 분석 기능만 비활성화됩니다.

**참고:**
- tech-blog-comment는 public 저장소이므로 Issue 읽기에 토큰이 필요없습니다.
- GitHub Actions의 기본 `GITHUB_TOKEN`은 다른 저장소에 접근할 수 없으므로 Personal Access Token이 필요합니다.

### member.yaml 설정

tech-blog 저장소의 `src/templates/Post/member.yaml`에 각 작성자의 GitHub username이 설정되어 있어야 합니다:

```yaml
- id: author_id
  name: Author Name
  github: github-username  # 이 필드가 필요
```

## 트러블슈팅

### Issue 제목 형식

스크립트는 Issue 제목에서 날짜와 slug를 추출합니다. utterances는 페이지 URL을 Issue 제목으로 사용하므로 다음 형식이어야 합니다:

```
https://oliveyoung.tech/blog/2025-07-22-what-is-MFE-part1/
```

패턴: `YYYY-MM-DD-slug` 또는 `YYYY-MM-DD/slug`

### 로컬 테스트 시 주의사항

1. `oliveyoung-tech-blog` 저장소가 올바른 위치에 있는지 확인 (../oliveyoung-tech-blog)
2. `oy-techblog/tech-blog-comment` 저장소의 테스트할 Issue가 실제로 존재하는지 확인
3. Issue 제목이 올바른 형식인지 확인 (포스트 URL 포함)
4. 실제 Issue 생성 시에만 `GITHUB_TOKEN`과 `ENABLE_NOTIFICATION=true` 필요
5. 토큰은 `oy-alldev/oliveyoung-tech-blog` 저장소에 Issue를 생성할 권한이 있어야 함

## GitHub Actions Workflow

### 트리거 조건

`.github/workflows/notify-author.yml`은 다음 이벤트에서 자동 실행됩니다:

- `issues.opened`: tech-blog-comment에 새 Issue 생성 시 (utterances 첫 댓글)
- `issue_comment.created`: tech-blog-comment의 Issue에 댓글 추가 시

### Workflow 단계

1. **Bot 댓글 필터링**: GitHub Actions bot의 댓글은 무시 (무한 루프 방지)
2. **저장소 체크아웃**:
   - `tech-blog-comment` (스크립트 포함)
   - `oliveyoung-tech-blog` (포스트/member.yaml 읽기)
3. **Node.js 설정 및 의존성 설치**
4. **알림 스크립트 실행**:
   - Issue 제목에서 포스트 정보 추출
   - 포스트 작성자 찾기
   - oliveyoung-tech-blog에 알림 Issue 생성 또는 댓글 추가

### 필요한 권한

- `issues: read` - tech-blog-comment Issue 읽기
- `TECH_BLOG_ACCESS_TOKEN` - oliveyoung-tech-blog 접근 및 Issue 생성

## 개발

스크립트를 수정한 후 로컬에서 테스트한 다음 커밋하면 GitHub Actions가 자동으로 새 버전을 사용합니다.

### 테스트 방법

1. 로컬에서 수정 및 테스트
2. 변경사항 커밋 및 푸시
3. utterances로 테스트 댓글 작성
4. GitHub Actions 로그 확인: Actions 탭에서 workflow 실행 결과 확인
