# GitHub에 images/ 폴더 업로드 가이드

## 📁 업로드할 파일들

GenSpark의 `images/` 폴더에 있는 파일:
1. `logo.png` (130KB)
2. `logo-transparent.png` (131KB)
3. `logo-new.png` (118KB)

---

## 📤 업로드 방법

### Option 1: GitHub 웹 UI (가장 쉬움)

1. https://github.com/Gon-Hwang/bttprayer 접속
2. **"Add file"** → **"Upload files"** 클릭
3. GenSpark Files 탭 → `images/` 폴더 다운로드
4. 다운로드한 `images/` 폴더를 GitHub 업로드 화면으로 드래그
5. Commit message: "Add images folder"
6. **"Commit changes"** 클릭

### Option 2: 파일 링크 직접 사용

GenSpark에서 이미지 파일들을 다운로드할 수 있습니다:
- GenSpark Files 탭
- `images/` 폴더 선택
- 다운로드 버튼 클릭

---

## ✅ 완료 확인

업로드 후 GitHub 저장소에서 확인:
```
📁 bttprayer/
  📁 css/
  📁 js/
  📁 images/          ← 새로 추가됨
     └── logo.png
     └── logo-transparent.png
     └── logo-new.png
  📄 index.html
  📄 README.md
```

---

## 🚀 다음 단계

images/ 폴더 업로드 완료 후:
→ Cloudflare Pages 연동 진행
