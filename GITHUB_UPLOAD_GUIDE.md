# 보좌 앞에서 (BTT Ministry) - GitHub 업로드 가이드

## 🚀 빠른 업로드 방법

### 방법 1: 스크립트 실행 (추천)

터미널에서 실행:

```bash
chmod +x push-to-github.sh
./push-to-github.sh
```

Git 인증이 필요하면 GitHub 계정 정보 입력

### 방법 2: 수동 Git 명령어

```bash
git init
git remote add origin https://github.com/Gon-Hwang/bttprayer.git
git add .
git commit -m "Initial commit"
git branch -M main
git push -u origin main
```

### 방법 3: GitHub Desktop 사용

1. GitHub Desktop 실행
2. File → Add Local Repository
3. 현재 폴더 선택
4. Publish repository

## 📦 업로드될 파일

- ✅ index.html (메인 페이지)
- ✅ css/style.css (스타일)
- ✅ js/main.js (JavaScript)
- ✅ images/ (이미지 파일들)
- ✅ admin-password-reset.html
- ✅ send-sms.html
- ✅ test-email.html
- ✅ favicon.svg
- ✅ README.md

## ⚠️ GitHub 인증 필요

첫 푸시 시 GitHub 계정 인증이 필요합니다:
- Username: Gon-Hwang
- Password: Personal Access Token 또는 비밀번호

## 🔗 다음 단계

업로드 후:
1. Cursor에서 저장소 클론
2. Cloudflare Pages와 GitHub 연동
3. 자동 배포 설정

## 📞 문제 발생 시

"Permission denied" 오류:
→ Personal Access Token 생성 필요
→ GitHub Settings → Developer settings → Personal access tokens
