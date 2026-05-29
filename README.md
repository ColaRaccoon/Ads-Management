# Meta Ads Performance Hub

CSV 업로드 기반 Meta 광고 성과 분석/운영 판단 보조 웹앱입니다. 광고 ON/OFF나 예산 변경은 직접 실행하지 않으며, 추천/후보와 운영 변경 로그만 제공합니다.

## 구조

- `apps/api`: NestJS + Prisma API
- `apps/web`: Next.js 업무용 대시보드
- `packages/shared`: 공통 타입

## 환경 값

실제 `.env`는 저장소에 만들지 않습니다. 아래 예시 파일을 복사해 사용자가 직접 값을 입력하세요.

- `apps/api/.env.example`
- `apps/web/.env.example`

필수 API 환경 값:

```env
DATABASE_URL="postgresql://meta_ads_app:<PASSWORD>@localhost:5432/meta_ads_performance?schema=public"
PORT=4100
UPLOAD_STORAGE_DIR="./storage/uploads"
REPORT_STORAGE_DIR="./storage/reports"
KOREA_EXIM_API_KEY=""
EXCHANGE_RATE_PROVIDER="KOREA_EXIM"
EXCHANGE_RATE_LOOKBACK_DAYS=10
```

`KOREA_EXIM_API_KEY`는 한국수출입은행 현재환율 API 인증키입니다. 업로드 시 CSV의 고유 날짜별로 USD/KRW 환율을 확보해 `exchange_rates`에 저장하며, 비영업일은 요청일 이하의 가장 최근 환율을 우선 사용합니다.

## 실행

```powershell
npm.cmd install
npm.cmd run prisma:validate
npm.cmd run test
npm.cmd run build
npm.cmd run dev
```

- Web: `http://localhost:3100`
- API: `http://localhost:4100/api`

DB 생성/마이그레이션은 사용자가 실제 `DATABASE_URL`을 입력한 뒤 실행합니다.

```powershell
cd apps/api
npx.cmd prisma migrate dev
npx.cmd prisma db seed
```
