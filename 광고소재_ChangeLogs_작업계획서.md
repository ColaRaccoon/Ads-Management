# 광고소재 중심 Change Logs 작업계획서

작성일: 2026-06-04  
대상 프로젝트: `C:\Users\seong\Desktop\workspace\Meta-Ads-Performance`  
참고 CSV: `C:\Users\seong\Downloads\Patima-group-파티마그룹-광고-2026.-6.-3.-~-2026.-6.-3. (1).csv`

## 1. 이 문서의 목적

다음 세션에서 이 문서 하나만 읽고도 바로 구현에 들어갈 수 있도록, 사용자가 원하는 Change Logs 페이지의 방향, CSV 기반 소재 객체화 로직, 백엔드/프론트 수정 지점, OOP 구조, 재활용 가능한 기존 코드, 테스트 항목을 정리한다.

이번 작업의 핵심은 기존 Change Logs의 `제품/광고세트/단계 변경 메모` 중심 구조를 `광고소재 객체 중심의 관찰/변경 이력 시스템`으로 바꾸는 것이다.

## 2. 사용자 요구사항 확정본

### 2.1 핵심 목표

매일 Meta 광고 CSV를 업로드하면, 프로그램이 CSV의 각 광고 row를 읽고 광고소재 단위로 객체화해야 한다. 사용자는 Change Logs 페이지에서 소재 객체 목록을 바로 보고, 각 소재 객체를 클릭해서 아래 정보를 확인하고 기록할 수 있어야 한다.

- 소재가 언제 처음 발견되었는지
- 해당 소재가 어떤 광고 세트들에 들어가 있는지
- 날짜별 성과가 어떻게 쌓였는지
- 어떤 날짜에 어떤 운영 판단/변경을 했는지
- 변경 또는 유지 판단의 사유가 무엇인지
- 다음 확인일 또는 후속 조치가 무엇인지

### 2.2 가장 중요한 기준

광고 세트가 아니라 `광고소재`가 1차 객체다.

```text
광고소재 = 주인공
광고세트 = 그 소재가 들어간 위치/사용처
캠페인 = 그 소재가 들어간 상위 위치/사용처
CSV = 매일 들어오는 성과/상태 스냅샷
Change Log = 소재 단위 관찰 기록 및 수동 운영 판단 기록
```

### 2.3 광고 ID를 기준으로 삼지 않는다

사용자가 명확히 결정한 사항:

- 같은 원본 동영상 파일을 업로드해서 광고를 여러 번 만들 수 있다.
- 이 경우 실제로는 같은 광고소재지만 Meta의 광고 ID는 서로 다르게 기록될 수 있다.
- 따라서 이 시스템은 광고 ID나 creative ID가 아니라 `광고 이름`을 기준으로 소재를 식별한다.
- 이름을 정확히 관리하는 책임은 사용자에게 있다.
- 시스템은 과하게 추정하거나 임의 병합하지 않고, 정해진 네이밍 규칙에 따라 파싱한다.

### 2.4 IG, FB는 소재 구분 기준이 아니다

`IG`, `FB`, `IG+FB` 등은 세팅값/배치값이지 별도 소재가 아니다.

예:

```text
버닝슬라이드_1번소재_IG    -> 버닝슬라이드_1번소재
버닝슬라이드_1번소재_FB    -> 버닝슬라이드_1번소재
버닝슬라이드_6번소재_IG+FB -> 버닝슬라이드_6번소재
```

즉 같은 소재로 묶어야 한다.

### 2.5 날짜 prefix도 소재 구분 기준이 아니다

현재 이름 형식은 다소 난잡하지만, 앞으로 아래 구조로 통일할 계획이다.

```text
날짜_제품명_소재번호_세팅값
```

예:

```text
260602_버닝웨이브바_02_IG
260602_버닝웨이브바_02_FB
260603_플로우라이트_09_IG+FB
```

여기서 `260602`, `260603` 같은 날짜 prefix는 소재 객체 식별 기준에서 제외한다.

따라서 아래 두 광고 이름은 같은 소재로 봐야 한다.

```text
260602_버닝웨이브바_02 -> 버닝웨이브바_02
버닝웨이브바_02        -> 버닝웨이브바_02
```

### 2.6 세트/캠페인 변경 이력 페이지가 아니다

이 페이지의 목적은 세트나 캠페인 변경 이력을 독립적으로 관리하는 것이 아니다.

- 소재 단위로 이력을 추적한다.
- 어떤 세트나 캠페인에서 사용되었는지는 소재 상세 안에서 확인한다.
- 세트별로 광고 객체를 분리하면 안 된다.
- 같은 광고 이름에서 파생된 같은 소재는 하나의 소재 객체로 묶고, 그 안에서 포함 광고 세트 목록을 보여준다.

## 3. 실제 CSV 확인 결과

업로드된 CSV를 확인한 결과:

- 총 행 수: 41
- 고유 광고 이름 수: 36
- 고유 광고 세트 이름 수: 21
- 고유 캠페인 수: 8
- `광고 ID`, `광고 소재 ID`, `creative ID` 컬럼은 없음
- 주요 컬럼:
  - `보고 시작`
  - `보고 종료`
  - `광고 이름`
  - `광고 게재`
  - `광고 세트 이름`
  - `캠페인 이름`
  - `광고 세트 ID`
  - `캠페인 ID`
  - `지출 금액 (USD)`
  - `노출`
  - `링크 클릭`
  - `구매 ROAS(광고 지출 대비 수익률)` 계열

실제 같은 광고 이름이 여러 광고 세트에 들어간 예:

```text
버닝웨이브바_02
- 버닝웨이브바_0518_관심사
- 버닝웨이브바_0520_관심사
- 버닝웨이브바_0526_관심사_소재분리

버닝웨이브바_03
- 버닝웨이브바_0518_관심사
- 버닝웨이브바_0520_관심사
- 버닝웨이브바_0526_관심사_소재분리

버닝슬라이드_07
- 버닝슬라이드_0515_관심사
- 버닝슬라이드_0521_관심사_소재분리
```

실제 형식 통일 전/후 이름이 섞일 수 있는 예:

```text
버닝웨이브바_02
260602_버닝웨이브바_02
```

위 둘은 같은 소재인 `버닝웨이브바_02`로 묶어야 한다.

## 4. 광고 이름 파싱 규칙

### 4.1 확정 네이밍 규칙

권장 광고 이름 형식:

```text
날짜_제품명_소재번호_세팅값
```

필드 의미:

```text
날짜: 선택값. YYMMDD 또는 YYYYMMDD 형식. 예: 260602
제품명: 필수. 예: 버닝웨이브바
소재번호: 필수. 예: 02, 1번소재, 인플03
세팅값: 선택값. IG, FB, IG+FB 등. 소재 구분 기준에서 제외
```

### 4.2 소재 key 생성 규칙

`creativeKey = 제품명 + "_" + 소재번호`

예:

```text
260602_버닝웨이브바_02      -> creativeKey: 버닝웨이브바_02
버닝웨이브바_02             -> creativeKey: 버닝웨이브바_02
260603_플로우라이트_09      -> creativeKey: 플로우라이트_09
버닝슬라이드_1번소재_IG      -> creativeKey: 버닝슬라이드_1번소재
버닝슬라이드_1번소재_FB      -> creativeKey: 버닝슬라이드_1번소재
버닝슬라이드_6번소재_IG+FB   -> creativeKey: 버닝슬라이드_6번소재
0527_플로우_인플03          -> creativeKey: 플로우_인플03
```

### 4.3 파싱 알고리즘

의사코드:

```ts
const SETTING_SUFFIXES = new Set(["IG", "FB", "IG+FB", "FB+IG"]);

function parseCreativeName(adName: string): CreativeNameParts {
  const originalName = adName.trim();
  const parts = originalName.split("_").map((part) => part.trim()).filter(Boolean);

  const dateCode = isDatePrefix(parts[0]) ? parts.shift() ?? null : null;
  const setting = isSettingSuffix(parts[parts.length - 1]) ? parts.pop() ?? null : null;

  if (parts.length < 2) {
    return {
      originalName,
      dateCode,
      productName: parts[0] ?? originalName,
      materialNo: null,
      setting,
      creativeKey: originalName,
      parseStatus: "FALLBACK"
    };
  }

  const materialNo = parts.pop()!;
  const productName = parts.join("_");

  return {
    originalName,
    dateCode,
    productName,
    materialNo,
    setting,
    creativeKey: `${productName}_${materialNo}`,
    parseStatus: "PARSED"
  };
}
```

날짜 prefix 판정:

```ts
function isDatePrefix(value: string | undefined) {
  if (!value) return false;
  return /^\d{6}$/.test(value) || /^\d{8}$/.test(value);
}
```

세팅 suffix 판정:

```ts
function isSettingSuffix(value: string | undefined) {
  if (!value) return false;
  return SETTING_SUFFIXES.has(value.toUpperCase());
}
```

주의:

- 날짜 prefix는 소재 key에서 제외하지만 alias metadata로 저장한다.
- IG/FB 세팅값도 소재 key에서 제외하지만 alias metadata로 저장한다.
- 파싱이 애매한 이름은 임의 추정하지 않고 `parseStatus = FALLBACK`으로 저장한다.
- 그래도 Change Logs 화면에는 표시되어야 한다.

## 5. 현재 코드베이스 관찰

### 5.1 프로젝트 구조

```text
apps/api: NestJS + Prisma API
apps/web: Next.js 프론트
packages/shared: 공통 패키지
```

주요 실행 명령:

```powershell
npm.cmd run prisma:validate
npm.cmd run prisma:generate
npm.cmd run test
npm.cmd run build
npm.cmd run dev
```

### 5.2 기존 Change Logs 상태

현재 파일:

```text
apps/api/src/change-logs/change-logs.service.ts
apps/api/src/change-logs/change-logs.controller.ts
apps/api/src/change-logs/change-logs.module.ts
apps/web/src/app/change-logs/page.tsx
apps/api/prisma/schema.prisma
```

현재 `ChangeLog` 모델은 아래 구조에 가깝다.

```text
ChangeLog
- actionDate
- actionType
- targetType
- productId
- metaAdsetId
- stageFrom
- stageTo
- previousValue
- newValue
- reason
- relatedDecisionId
- nextCheckDate
```

현재 `targetType` 허용값:

```text
PRODUCT
ADSET
STAGE
```

현재 `actionType` 허용값:

```text
TURN_OFF
BUDGET_CHANGE
PROMOTE_STAGE
DEMOTE_STAGE
CREATIVE_EXCLUDE
NOTE
```

문제:

- 소재 객체가 없다.
- 소재 단위 로그가 없다.
- Change Logs 페이지가 dropdown/select 중심이다.
- 화면 진입 시 소재 객체 텍스트박스 목록이 보이지 않는다.
- 현재 페이지 문구가 인코딩 깨짐 상태다.

### 5.3 기존 CSV 업로드 흐름

현재 광고 단위 CSV 업로드는 이미 구현되어 있다.

관련 파일:

```text
apps/api/src/uploads/uploads.service.ts
apps/api/src/domain/meta-ad-daily-csv.ts
```

중요 함수:

```text
UploadsService.importMetaAdDailyCsv()
UploadsService.upsertCampaign()
UploadsService.upsertAdsetFromAdDaily()
UploadsService.upsertAd()
UploadsService.importAdDailyMetric()
MetaAdDailyCsvParser.parseBuffer()
MetaAdDailyCsvParser.parseRow()
MetaAdDailyCsvParser.preview()
syntheticAdKey()
dailyAdMetricKey()
```

현재 흐름:

```text
CSV 업로드
-> MetaAdDailyCsvParser.parseBuffer()
-> 각 row parseRow()
-> upsertCampaign()
-> upsertAdsetFromAdDaily()
-> upsertAd()
-> importAdDailyMetric()
-> refreshAdsetAggregatesFromAdMetrics()
```

이 흐름을 재활용해야 한다.

### 5.4 기존 DB 모델 중 재활용 대상

이미 존재:

```text
MetaCampaign
MetaAdset
MetaAd
MetaAdDailyMetric
UploadBatch
UploadRow
ChangeLog
Product
```

재활용 방식:

- `MetaAdDailyMetric`: 날짜별 광고 row 성과 저장소로 계속 사용한다.
- `MetaAd`: Meta 광고 row의 개별 광고 인스턴스로 계속 사용한다.
- `MetaAdset`: 소재가 들어간 사용처 정보로 활용한다.
- `MetaCampaign`: 소재가 들어간 상위 사용처 정보로 활용한다.
- `UploadBatch`, `UploadRow`: 업로드 이력과 원천 row 보관에 그대로 사용한다.
- `ChangeLog`: 기존 모델을 확장하거나 새 소재 로그 모델을 만들 때 참고한다.

## 6. 새로 추가할 도메인 모델

### 6.1 OOP 관점의 객체 정의

이 기능은 아래 객체들을 중심으로 구현한다.

```text
Creative
- 한 광고소재를 나타내는 중심 객체
- creativeKey 기준으로 unique
- 예: 버닝웨이브바_02

CreativeAlias
- 실제 CSV에 등장한 원본 광고 이름
- 같은 Creative에 여러 alias가 붙을 수 있음
- 예: 버닝웨이브바_02, 260602_버닝웨이브바_02, 버닝슬라이드_1번소재_IG

CreativePlacement
- 이 소재가 어떤 캠페인/광고세트/광고 인스턴스에서 쓰였는지 나타내는 사용처 객체
- 같은 Creative가 여러 광고 세트에 들어갈 수 있음

CreativeChangeLog
- 소재 단위 수동 운영 기록
- 세트나 캠페인 이력 자체가 아니라 소재 객체에 붙는 관찰/판단/변경 기록

CreativeNameParser
- 광고 이름을 Creative key와 metadata로 파싱하는 도메인 클래스

CreativeSnapshotReader 또는 CreativeQueryService
- 소재 목록/상세 화면에 필요한 집계 데이터를 만드는 서비스
```

### 6.2 Prisma 모델 제안

`apps/api/prisma/schema.prisma`에 추가한다.

권장 enum:

```prisma
enum CreativeParseStatus {
  PARSED
  FALLBACK

  @@map("creative_parse_status")
}

enum CreativeLogActionType {
  NOTE
  TURN_ON
  TURN_OFF
  KEEP
  WATCH
  SCALE
  REDUCE
  CREATIVE_TEST
  CREATIVE_EXCLUDE
  OTHER

  @@map("creative_log_action_type")
}
```

권장 모델:

```prisma
model Creative {
  id             String              @id @default(uuid()) @db.Uuid
  platform       String              @default("META")
  creativeKey    String              @map("creative_key")
  displayName    String              @map("display_name")
  productName    String?             @map("product_name")
  materialNo     String?             @map("material_no")
  firstSeenOn    DateTime?           @map("first_seen_on") @db.Date
  lastSeenOn     DateTime?           @map("last_seen_on") @db.Date
  isActive       Boolean             @default(true) @map("is_active")
  createdAt      DateTime            @default(now()) @map("created_at")
  updatedAt      DateTime            @updatedAt @map("updated_at")
  aliases        CreativeAlias[]
  placements     CreativePlacement[]
  changeLogs     CreativeChangeLog[]
  ads            MetaAd[]
  adDailyMetrics MetaAdDailyMetric[]

  @@unique([platform, creativeKey])
  @@index([displayName])
  @@map("creatives")
}

model CreativeAlias {
  id            String              @id @default(uuid()) @db.Uuid
  creativeId    String              @map("creative_id") @db.Uuid
  originalName  String              @map("original_name")
  originalKey   String              @map("original_key")
  dateCode      String?             @map("date_code")
  setting       String?
  parseStatus   CreativeParseStatus @default(PARSED) @map("parse_status")
  firstSeenOn   DateTime?           @map("first_seen_on") @db.Date
  lastSeenOn    DateTime?           @map("last_seen_on") @db.Date
  createdAt     DateTime            @default(now()) @map("created_at")
  updatedAt     DateTime            @updatedAt @map("updated_at")
  creative      Creative            @relation(fields: [creativeId], references: [id])

  @@unique([creativeId, originalKey])
  @@index([originalKey])
  @@map("creative_aliases")
}

model CreativePlacement {
  id             String       @id @default(uuid()) @db.Uuid
  creativeId     String       @map("creative_id") @db.Uuid
  metaCampaignId String       @map("meta_campaign_id")
  metaAdsetId    String       @map("meta_adset_id")
  metaAdRefId    String?      @map("meta_ad_ref_id") @db.Uuid
  campaignRefId  String?      @map("campaign_ref_id") @db.Uuid
  metaAdsetRefId String?      @map("meta_adset_ref_id") @db.Uuid
  campaignName   String       @map("campaign_name")
  adsetName      String       @map("adset_name")
  originalAdName String       @map("original_ad_name")
  setting        String?
  firstSeenOn    DateTime?    @map("first_seen_on") @db.Date
  lastSeenOn     DateTime?    @map("last_seen_on") @db.Date
  lastStatus     String?      @map("last_status")
  createdAt      DateTime     @default(now()) @map("created_at")
  updatedAt      DateTime     @updatedAt @map("updated_at")
  creative       Creative     @relation(fields: [creativeId], references: [id])
  metaAd         MetaAd?      @relation(fields: [metaAdRefId], references: [id])
  campaign       MetaCampaign? @relation(fields: [campaignRefId], references: [id])
  metaAdset      MetaAdset?   @relation(fields: [metaAdsetRefId], references: [id])

  @@unique([creativeId, metaCampaignId, metaAdsetId, originalAdName])
  @@index([creativeId, lastSeenOn])
  @@index([metaCampaignId, metaAdsetId])
  @@map("creative_placements")
}

model CreativeChangeLog {
  id              String                @id @default(uuid()) @db.Uuid
  creativeId      String                @map("creative_id") @db.Uuid
  actionDate      DateTime              @default(now()) @map("action_date") @db.Date
  actionType      CreativeLogActionType @default(NOTE) @map("action_type")
  reason          String
  memo            String?
  relatedAdsetIds Json                  @default("[]") @map("related_adset_ids")
  nextCheckDate   DateTime?             @map("next_check_date") @db.Date
  createdBy       String?               @map("created_by") @db.Uuid
  createdAt       DateTime              @default(now()) @map("created_at")
  updatedAt       DateTime              @updatedAt @map("updated_at")
  creative        Creative              @relation(fields: [creativeId], references: [id])

  @@index([creativeId, actionDate])
  @@index([actionDate, actionType])
  @@map("creative_change_logs")
}
```

`MetaAd`와 `MetaAdDailyMetric`에 연결 필드를 추가한다.

```prisma
model MetaAd {
  creativeId String? @map("creative_id") @db.Uuid
  creative   Creative? @relation(fields: [creativeId], references: [id])
  placements CreativePlacement[]

  @@index([creativeId])
}

model MetaAdDailyMetric {
  creativeId String? @map("creative_id") @db.Uuid
  creative   Creative? @relation(fields: [creativeId], references: [id])

  @@index([creativeId, metricDate])
}
```

`MetaCampaign`, `MetaAdset`에도 relation 배열을 추가하면 Prisma include가 편하다.

```prisma
model MetaCampaign {
  creativePlacements CreativePlacement[]
}

model MetaAdset {
  creativePlacements CreativePlacement[]
}
```

### 6.3 기존 ChangeLog를 확장할지, 새 CreativeChangeLog를 만들지

권장: 새 `CreativeChangeLog`를 만든다.

이유:

- 기존 `ChangeLog`는 product/adset/stage 운영 로그로 설계되어 있다.
- 소재 중심 이력은 `creativeId`가 필수이고, 관련 광고 세트는 보조 정보다.
- 기존 테이블을 억지로 확장하면 `targetType`, `productId`, `metaAdsetId` 의미가 흐려진다.
- 기존 report export나 decisions 연결과 충돌할 수 있다.

기존 `ChangeLog`는 유지하고, Change Logs 페이지는 새 `CreativeChangeLog` 중심으로 재구성한다. 필요하면 기존 로그 테이블은 추후 `Legacy / Operations Logs`로 남긴다.

## 7. 백엔드 구현 계획

### 7.1 새 도메인 파일 추가

추가 파일:

```text
apps/api/src/domain/creative-name-parser.ts
```

권장 클래스:

```ts
export type CreativeNameParts = {
  originalName: string;
  dateCode: string | null;
  productName: string | null;
  materialNo: string | null;
  setting: string | null;
  creativeKey: string;
  displayName: string;
  parseStatus: "PARSED" | "FALLBACK";
};

export class CreativeNameParser {
  parse(adName: string): CreativeNameParts {
    // 4장 파싱 알고리즘 구현
  }

  private isDatePrefix(value: string | undefined): boolean {
    return Boolean(value && (/^\d{6}$/.test(value) || /^\d{8}$/.test(value)));
  }

  private isSettingSuffix(value: string | undefined): boolean {
    return Boolean(value && SETTING_SUFFIXES.has(value.toUpperCase()));
  }
}
```

이 클래스는 pure domain logic이어야 한다. DB 접근을 넣지 않는다.

### 7.2 업로드 서비스에 Creative upsert 추가

수정 파일:

```text
apps/api/src/uploads/uploads.service.ts
```

현재 `importMetaAdDailyCsv()` 루프 안에서 아래 순서로 진행된다.

```text
upsertCampaign()
upsertAdsetFromAdDaily()
upsertAd()
importAdDailyMetric()
```

수정 후 권장 순서:

```text
upsertCampaign()
upsertAdsetFromAdDaily()
upsertCreativeFromAdDaily()
upsertAd(parsedRow, campaign.id, metaAdset.id, creative.id)
upsertCreativeAlias()
upsertCreativePlacement()
importAdDailyMetric(..., creativeId)
```

구체적 변경:

1. `UploadsService`에 `private readonly creativeNameParser = new CreativeNameParser();` 추가
2. `upsertCreativeFromAdDaily(parsedRow)` 추가
3. `upsertAd()` 시그니처에 `creativeId` 추가
4. `MetaAd` create/update 시 `creativeId` 저장
5. `AdMetricImportInput`에 `creativeId` 추가
6. `MetaAdDailyMetric` create 시 `creativeId` 저장
7. alias/placement firstSeenOn/lastSeenOn 갱신

의사코드:

```ts
private async upsertCreativeFromAdDaily(parsedRow: ParsedMetaAdDailyRow) {
  const parsed = this.creativeNameParser.parse(parsedRow.adName);

  const creative = await this.prisma.creative.upsert({
    where: {
      platform_creativeKey: {
        platform: "META",
        creativeKey: parsed.creativeKey
      }
    },
    update: {
      displayName: parsed.displayName,
      productName: parsed.productName,
      materialNo: parsed.materialNo,
      firstSeenOn: { set: undefined }, // 실제 구현에서는 기존값 보존 필요
      lastSeenOn: parsedRow.metricDate
    },
    create: {
      platform: "META",
      creativeKey: parsed.creativeKey,
      displayName: parsed.displayName,
      productName: parsed.productName,
      materialNo: parsed.materialNo,
      firstSeenOn: parsedRow.metricDate,
      lastSeenOn: parsedRow.metricDate
    }
  });

  await this.upsertCreativeAlias(creative.id, parsed, parsedRow.metricDate);

  return { creative, parsed };
}
```

주의: Prisma `upsert.update`에서 `firstSeenOn`은 기존값을 덮지 않도록 해야 한다. `upsert`만으로 min date를 정확히 처리하기 애매하면 `findUnique -> update/create` 방식으로 구현한다.

권장 구현:

```ts
private async upsertCreativeFromAdDaily(parsedRow: ParsedMetaAdDailyRow) {
  const parsedName = this.creativeNameParser.parse(parsedRow.adName);
  const existing = await this.prisma.creative.findUnique({
    where: {
      platform_creativeKey: {
        platform: "META",
        creativeKey: parsedName.creativeKey
      }
    }
  });

  const creative = existing
    ? await this.prisma.creative.update({
        where: { id: existing.id },
        data: {
          displayName: parsedName.displayName,
          productName: parsedName.productName,
          materialNo: parsedName.materialNo,
          firstSeenOn: existing.firstSeenOn ?? parsedRow.metricDate,
          lastSeenOn: parsedRow.metricDate,
          isActive: true
        }
      })
    : await this.prisma.creative.create({
        data: {
          platform: "META",
          creativeKey: parsedName.creativeKey,
          displayName: parsedName.displayName,
          productName: parsedName.productName,
          materialNo: parsedName.materialNo,
          firstSeenOn: parsedRow.metricDate,
          lastSeenOn: parsedRow.metricDate
        }
      });

  await this.upsertCreativeAlias(creative.id, parsedName, parsedRow.metricDate);
  return { creative, parsedName };
}
```

### 7.3 CreativeAlias upsert

목적:

- CSV에 들어온 실제 광고 이름을 보존한다.
- `버닝웨이브바_02`, `260602_버닝웨이브바_02`, `버닝슬라이드_1번소재_IG` 등이 같은 creative에 연결된 alias로 남는다.

의사코드:

```ts
private async upsertCreativeAlias(creativeId: string, parsedName: CreativeNameParts, metricDate: Date) {
  const originalKey = normalizeAliasKey(parsedName.originalName);
  const existing = await this.prisma.creativeAlias.findUnique({
    where: { creativeId_originalKey: { creativeId, originalKey } }
  });

  if (existing) {
    return this.prisma.creativeAlias.update({
      where: { id: existing.id },
      data: {
        lastSeenOn: metricDate,
        dateCode: parsedName.dateCode,
        setting: parsedName.setting,
        parseStatus: parsedName.parseStatus
      }
    });
  }

  return this.prisma.creativeAlias.create({
    data: {
      creativeId,
      originalName: parsedName.originalName,
      originalKey,
      dateCode: parsedName.dateCode,
      setting: parsedName.setting,
      parseStatus: parsedName.parseStatus,
      firstSeenOn: metricDate,
      lastSeenOn: metricDate
    }
  });
}
```

`normalizeAliasKey()`는 우선 단순 trim/lowercase 정도로 둔다. 한글은 그대로 보존한다.

### 7.4 CreativePlacement upsert

목적:

- 같은 소재가 어느 캠페인/광고세트/광고 인스턴스에서 사용되는지 확인한다.
- 사용자가 소재 상세에서 “이 소재가 들어간 세트 목록”을 확인할 수 있게 한다.

의사코드:

```ts
private async upsertCreativePlacement(input: {
  creativeId: string;
  parsedName: CreativeNameParts;
  parsedRow: ParsedMetaAdDailyRow;
  campaignRefId: string;
  metaAdsetRefId: string;
  metaAdRefId: string;
}) {
  const existing = await this.prisma.creativePlacement.findUnique({
    where: {
      creativeId_metaCampaignId_metaAdsetId_originalAdName: {
        creativeId: input.creativeId,
        metaCampaignId: input.parsedRow.metaCampaignId,
        metaAdsetId: input.parsedRow.metaAdsetExternalId,
        originalAdName: input.parsedRow.adName
      }
    }
  });

  const data = {
    campaignRefId: input.campaignRefId,
    metaAdsetRefId: input.metaAdsetRefId,
    metaAdRefId: input.metaAdRefId,
    campaignName: input.parsedRow.campaignName,
    adsetName: input.parsedRow.adsetName,
    setting: input.parsedName.setting,
    lastSeenOn: input.parsedRow.metricDate,
    lastStatus: input.parsedRow.adDeliveryStatus
  };

  if (existing) {
    return this.prisma.creativePlacement.update({
      where: { id: existing.id },
      data
    });
  }

  return this.prisma.creativePlacement.create({
    data: {
      creativeId: input.creativeId,
      metaCampaignId: input.parsedRow.metaCampaignId,
      metaAdsetId: input.parsedRow.metaAdsetExternalId,
      originalAdName: input.parsedRow.adName,
      firstSeenOn: input.parsedRow.metricDate,
      ...data
    }
  });
}
```

중요:

- placement unique key에 `originalAdName`을 포함한다.
- 이유: 같은 creative가 같은 세트 안에서 IG/FB 같은 원본 광고 이름으로 여러 row를 가질 수 있다.
- 하지만 UI에서는 같은 세트가 중복 표시되지 않도록 세트 기준으로 묶어서 보여준다.

### 7.5 ChangeLogsService 재구성

수정 파일:

```text
apps/api/src/change-logs/change-logs.service.ts
apps/api/src/change-logs/change-logs.controller.ts
```

새 API:

```text
GET  /change-logs/creatives?from=YYYY-MM-DD&to=YYYY-MM-DD
GET  /change-logs/creatives/:creativeId
POST /change-logs/creatives/:creativeId/logs
```

기존 API:

```text
GET /change-logs
POST /change-logs
```

기존 API는 당장 삭제하지 말고 남겨도 된다. 다만 프론트 Change Logs 페이지는 새 API를 사용한다.

#### 7.5.1 소재 목록 API 응답 형태

```ts
type CreativeListItemDto = {
  id: string;
  creativeKey: string;
  displayName: string;
  productName: string | null;
  materialNo: string | null;
  firstSeenOn: string | null;
  lastSeenOn: string | null;
  aliasCount: number;
  placementCount: number;
  activePlacementCount: number;
  settings: string[];
  originalNames: string[];
  latestMetrics: {
    metricDate: string | null;
    spendUsd: number;
    purchaseCount: number;
    impressions: number;
    linkClicks: number;
    landingPageViews: number;
    statuses: string[];
  };
  latestLog: {
    actionDate: string;
    actionType: string;
    reason: string;
  } | null;
};
```

목록 쿼리 로직:

- `Creative.findMany()`로 조회
- aliases include
- placements include
- latest metrics는 `MetaAdDailyMetric`에서 `creativeId` 기준, 기간 안의 current row만 집계
- 기본 정렬은 `lastSeenOn desc`, 그 다음 `displayName asc`

처음 구현에서는 고급 SQL보다 Prisma findMany + JS 집계로 시작해도 된다. 데이터량이 커지면 groupBy로 최적화한다.

#### 7.5.2 소재 상세 API 응답 형태

```ts
type CreativeDetailDto = {
  creative: {
    id: string;
    creativeKey: string;
    displayName: string;
    productName: string | null;
    materialNo: string | null;
    firstSeenOn: string | null;
    lastSeenOn: string | null;
  };
  aliases: Array<{
    originalName: string;
    dateCode: string | null;
    setting: string | null;
    parseStatus: string;
    firstSeenOn: string | null;
    lastSeenOn: string | null;
  }>;
  placements: Array<{
    campaignName: string;
    metaCampaignId: string;
    adsetName: string;
    metaAdsetId: string;
    originalAdNames: string[];
    settings: string[];
    firstSeenOn: string | null;
    lastSeenOn: string | null;
    lastStatus: string | null;
  }>;
  dailyMetrics: Array<{
    metricDate: string;
    spendUsd: number;
    purchaseCount: number;
    impressions: number;
    linkClicks: number;
    landingPageViews: number;
    statuses: string[];
  }>;
  logs: Array<{
    id: string;
    actionDate: string;
    actionType: string;
    reason: string;
    memo: string | null;
    relatedAdsetIds: string[];
    nextCheckDate: string | null;
    createdAt: string;
  }>;
};
```

상세의 `placements`는 DB row 그대로 보여주지 말고 `metaCampaignId + metaAdsetId` 기준으로 묶어서 보여준다.

#### 7.5.3 로그 생성 API

요청 body:

```ts
type CreateCreativeLogRequest = {
  actionDate: string;
  actionType: "NOTE" | "TURN_ON" | "TURN_OFF" | "KEEP" | "WATCH" | "SCALE" | "REDUCE" | "CREATIVE_TEST" | "CREATIVE_EXCLUDE" | "OTHER";
  reason: string;
  memo?: string;
  relatedAdsetIds?: string[];
  nextCheckDate?: string;
};
```

검증:

- `creativeId`는 URL param에서 받는다.
- `reason`은 필수다.
- `actionDate`가 없으면 오늘 날짜로 기본값.
- `relatedAdsetIds`는 선택값이다. 이 값은 소재에 속한 광고 세트 ID 목록 중 일부일 수 있다.
- 페이지 목적상 세트 로그가 아니라 소재 로그이므로 `relatedAdsetIds`는 “이 메모가 어느 세트에 관련 있는지”만 표시한다.

## 8. 프론트 구현 계획

### 8.1 현재 문제

현재 파일:

```text
apps/web/src/app/change-logs/page.tsx
```

현재 UI:

- 상단에 수동 입력 form
- `actionType`, `targetType` 드롭다운
- `metaAdsetId`, `productId` 직접 입력
- 아래에 DataTable 로그 목록

사용자 요구와 맞지 않는다.

사용자 요구:

- Change Logs 페이지에 들어가면 소재 객체들이 텍스트박스 형태로 바로 보여야 한다.
- 드롭다운 기반으로 먼저 대상을 고르는 방식이 아니다.
- 각 소재 텍스트박스를 클릭하면 상세 이력과 추가 입력사항이 보여야 한다.

### 8.2 새 화면 구조

권장 레이아웃:

```text
Change Logs
┌──────────────────────────────────────────────┐
│ 검색/날짜 범위/요약                           │
└──────────────────────────────────────────────┘

┌────────────────────────────┬─────────────────────────────┐
│ 소재 텍스트박스 목록        │ 선택된 소재 상세             │
│                            │                             │
│ [버닝웨이브바_02]          │ 소재 기본 정보               │
│ 사용 세트 4개              │ 원본 광고명                  │
│ 원본 광고명 2개            │ 사용 세트 목록               │
│ 최근 지출 $58.64           │ 날짜별 성과                  │
│ 최근 로그: WATCH           │ 변경 메모 타임라인           │
│                            │ 새 메모 입력                 │
│ [버닝슬라이드_1번소재]     │                             │
└────────────────────────────┴─────────────────────────────┘
```

모바일에서는 1열로 쌓는다.

### 8.3 소재 텍스트박스 카드

사용자가 “텍스트박스 형태”라고 표현했으므로 화려한 카드가 아니라, 클릭 가능한 조밀한 박스 리스트가 좋다.

각 박스 표시 정보:

```text
소재명
사용 세트 N개
원본 광고명 N개
세팅값: IG, FB, 없음
최근 발견일
최근 지출 / 구매 / 클릭
최근 변경 로그 한 줄
```

예:

```text
[버닝웨이브바_02]
사용 세트 4개 / 원본 광고명 2개 / 최근 상태 active 포함
최근 지출 $58.64 / 구매 2 / 링크클릭 18
최근 기록: 2026-06-04 WATCH - 성과 확인 중
```

### 8.4 상세 패널

소재 박스를 클릭하면 오른쪽 패널에 표시한다. 별도 dropdown 없이 selectedCreativeId state로 관리한다.

상세 섹션:

```text
1. 소재 기본 정보
2. 원본 광고 이름 목록
3. 들어가 있는 광고 세트 목록
4. 날짜별 성과 요약
5. 변경 기록 타임라인
6. 새 변경 기록 입력창
```

사용 세트 목록은 캠페인/광고세트 기준:

```text
버닝웨이브바_CBO / 버닝웨이브바_0518_관심사
- 상태: inactive
- 최초 발견: 2026-06-03
- 최근 발견: 2026-06-03
- 원본 광고명: 버닝웨이브바_02

SC_버닝웨이브바 / 260602_버닝웨이브바_소재_02
- 상태: active
- 원본 광고명: 260602_버닝웨이브바_02
```

### 8.5 새 메모 입력 UI

드롭다운을 완전히 금지한 것은 아니다. 사용자가 싫어한 것은 “대상을 드롭다운으로 골라 로그를 넣는 방식”이다. 소재 선택은 텍스트박스 클릭으로 하고, 선택된 소재 안에서 actionType 정도는 segmented button 또는 select를 사용할 수 있다.

권장:

- actionType은 버튼 그룹 형태
- 날짜 input
- 사유 textarea
- 추가 메모 textarea
- 관련 광고세트 체크박스 목록
- 다음 확인일 date input
- 저장 버튼

예:

```text
액션 버튼:
[NOTE] [KEEP] [WATCH] [SCALE] [REDUCE] [TURN_OFF] [OTHER]

관련 세트:
[ ] 버닝웨이브바_0518_관심사
[ ] 버닝웨이브바_0520_관심사
[ ] 버닝웨이브바_0526_관심사_소재분리

사유:
성과 확인 중. 0526 세트에서만 반응이 있어 유지.
```

### 8.6 CSS 추가

수정 파일:

```text
apps/web/src/app/globals.css
```

추가 클래스 예:

```css
.creative-log-layout {
  display: grid;
  grid-template-columns: minmax(320px, 0.9fr) minmax(0, 1.4fr);
  gap: 12px;
  align-items: start;
}

.creative-list {
  display: grid;
  gap: 8px;
}

.creative-item {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  padding: 11px 12px;
  text-align: left;
  cursor: pointer;
}

.creative-item.active {
  border-color: var(--brand);
  background: var(--brand-weak);
}

.creative-item-title {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-weight: 700;
}

.creative-item-meta {
  margin-top: 6px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}

.creative-detail {
  display: grid;
  gap: 12px;
}

.timeline {
  display: grid;
  gap: 8px;
}

.timeline-item {
  border-left: 3px solid var(--line-strong);
  padding: 8px 10px;
  background: #fbfcfd;
  border-radius: 0 6px 6px 0;
}

.action-segments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.action-segments button {
  min-height: 30px;
}

@media (max-width: 980px) {
  .creative-log-layout {
    grid-template-columns: 1fr;
  }
}
```

### 8.7 프론트 API 타입

수정 파일:

```text
apps/web/src/types/api.ts
```

또는 `change-logs/page.tsx` 내부 type으로 시작해도 된다.

권장 타입:

```ts
type CreativeListItem = {
  id: string;
  creativeKey: string;
  displayName: string;
  firstSeenOn: string | null;
  lastSeenOn: string | null;
  aliasCount: number;
  placementCount: number;
  activePlacementCount: number;
  settings: string[];
  originalNames: string[];
  latestMetrics: {
    metricDate: string | null;
    spendUsd: number;
    purchaseCount: number;
    impressions: number;
    linkClicks: number;
    landingPageViews: number;
    statuses: string[];
  };
  latestLog: {
    actionDate: string;
    actionType: string;
    reason: string;
  } | null;
};
```

## 9. 기존 함수/로직 재활용 정리

### 9.1 그대로 재활용

```text
MetaAdDailyCsvParser.parseBuffer()
MetaAdDailyCsvParser.parseRow()
MetaAdDailyCsvParser.preview()
MetaAdDailyCsvValidator.validate()
hashRecord()
DuplicatePolicyResolver
formatDateOnly()
asDateOnly()
parseDateRange()
apiGet()
apiPost()
rangeQuery()
useRange()
DataTable
panel/input/button CSS
```

### 9.2 일부 수정해서 재활용

```text
UploadsService.importMetaAdDailyCsv()
- creative upsert, alias upsert, placement upsert 추가

UploadsService.upsertAd()
- creativeId를 받아 MetaAd에 연결

UploadsService.importAdDailyMetric()
- creativeId를 받아 MetaAdDailyMetric에 저장

ChangeLogsService
- 기존 list/create는 유지 가능
- 새 creative list/detail/create-log 메서드 추가

ChangeLogsController
- /change-logs/creatives 엔드포인트 추가

apps/web/src/app/change-logs/page.tsx
- 현재 form/table 중심 UI를 소재 목록/상세 패널 UI로 교체
```

### 9.3 새로 만들어야 하는 것

```text
apps/api/src/domain/creative-name-parser.ts
Prisma Creative / CreativeAlias / CreativePlacement / CreativeChangeLog 모델
Creative 목록/상세 DTO 조립 로직
Creative 로그 생성 API
프론트 소재 목록 컴포넌트
프론트 소재 상세 패널
프론트 소재 로그 입력 폼
```

## 10. 구현 순서

### Step 1. Prisma schema 수정

수정:

```text
apps/api/prisma/schema.prisma
```

작업:

- `CreativeParseStatus` enum 추가
- `CreativeLogActionType` enum 추가
- `Creative` 모델 추가
- `CreativeAlias` 모델 추가
- `CreativePlacement` 모델 추가
- `CreativeChangeLog` 모델 추가
- `MetaAd.creativeId` 추가
- `MetaAdDailyMetric.creativeId` 추가
- relation 배열 추가

검증:

```powershell
npm.cmd run prisma:validate
```

마이그레이션:

```powershell
npm.cmd run prisma:migrate
npm.cmd run prisma:generate
```

### Step 2. CreativeNameParser 구현

추가:

```text
apps/api/src/domain/creative-name-parser.ts
```

테스트 추가:

```text
apps/api/src/domain/domain.spec.ts
```

필수 테스트 케이스:

```ts
버닝슬라이드_1번소재_IG    -> 버닝슬라이드_1번소재
버닝슬라이드_1번소재_FB    -> 버닝슬라이드_1번소재
버닝슬라이드_6번소재_IG+FB -> 버닝슬라이드_6번소재
260602_버닝웨이브바_02    -> 버닝웨이브바_02
버닝웨이브바_02           -> 버닝웨이브바_02
260603_플로우라이트_09    -> 플로우라이트_09
0527_플로우_인플03        -> 플로우_인플03
```

실행:

```powershell
npm.cmd --workspace @meta-ads-performance/api run test
```

### Step 3. 업로드 import에 소재 upsert 연결

수정:

```text
apps/api/src/uploads/uploads.service.ts
```

작업:

- `CreativeNameParser` import
- `private readonly creativeNameParser = new CreativeNameParser();`
- `upsertCreativeFromAdDaily()`
- `upsertCreativeAlias()`
- `upsertCreativePlacement()`
- `upsertAd()`에 `creativeId` 추가
- `importAdDailyMetric()`에 `creativeId` 추가

중요:

- 기존 `MetaAd` unique key는 그대로 둔다.
- `creativeId`는 같은 소재를 묶는 상위 연결 필드다.
- `adIdentityKey`와 `syntheticAdKey` 정책은 건드리지 않는다.

### Step 4. Change Logs API 확장

수정:

```text
apps/api/src/change-logs/change-logs.service.ts
apps/api/src/change-logs/change-logs.controller.ts
```

추가 메서드:

```ts
listCreatives(from?: string, to?: string)
getCreativeDetail(creativeId: string, from?: string, to?: string)
createCreativeLog(creativeId: string, body: Record<string, unknown>)
```

추가 route:

```ts
@Get("creatives")
@Get("creatives/:creativeId")
@Post("creatives/:creativeId/logs")
```

### Step 5. 프론트 Change Logs 페이지 교체

수정:

```text
apps/web/src/app/change-logs/page.tsx
apps/web/src/app/globals.css
```

구현:

- `useQuery(["creative-change-log-list", range], ...)`
- 첫 번째 소재를 기본 선택하거나, 사용자가 클릭할 때 선택
- 선택된 소재 id로 상세 query 호출
- 소재 박스 목록 렌더링
- 상세 패널 렌더링
- 로그 입력 mutation 구현
- 저장 성공 시 목록/상세 query invalidate

### Step 6. 검증

실행:

```powershell
npm.cmd run prisma:validate
npm.cmd run test
npm.cmd run build
```

프론트 확인:

```powershell
npm.cmd run dev
```

브라우저:

```text
http://localhost:3100/change-logs
```

확인 항목:

- CSV 업로드 후 소재 객체가 생성되는가
- `260602_버닝웨이브바_02`와 `버닝웨이브바_02`가 같은 `버닝웨이브바_02`로 묶이는가
- `버닝슬라이드_1번소재_IG`와 `버닝슬라이드_1번소재_FB`가 같은 `버닝슬라이드_1번소재`로 묶이는가
- 같은 소재의 여러 광고 세트가 상세에 표시되는가
- 소재 로그를 저장할 수 있는가
- 저장한 로그가 타임라인과 목록 최신 로그에 반영되는가
- 모바일 폭에서 목록/상세가 겹치지 않는가

## 11. 구현 시 주의사항

### 11.1 소재 key는 이름 규칙만 따른다

시스템이 같은 파일인지, 같은 영상인지, 같은 creative인지 추정하려고 하면 안 된다.

사용자 결정:

```text
같은 원본 파일을 썼는지 여부는 광고 이름으로만 관리한다.
이름 관리 책임은 사용자에게 있다.
```

### 11.2 세트별 객체 분리 금지

아래 방식은 잘못된 방향이다.

```text
버닝웨이브바_02 + 세트 A = 객체 1
버닝웨이브바_02 + 세트 B = 객체 2
```

올바른 방향:

```text
버닝웨이브바_02 = Creative 객체 1개
  - 세트 A placement
  - 세트 B placement
  - 세트 C placement
```

### 11.3 세트/캠페인 변경 로그로 만들지 않는다

세트나 캠페인 정보는 소재 상세 안의 context로 보여준다. 로그 자체는 반드시 소재에 붙는다.

예:

```text
CreativeChangeLog
- creativeId: 버닝웨이브바_02
- actionType: WATCH
- reason: 0526 세트에서만 지출이 발생해 하루 더 관찰
- relatedAdsetIds: [120248381413710494]
```

### 11.4 기존 광고 단위 metric key는 유지한다

`MetaAdDailyMetric`의 unique key는 여전히 아래 기준이다.

```text
metricDate + metaCampaignId + metaAdsetId + adIdentityKey + importVersion
```

이건 “CSV row 저장 중복 방지”용이다.

`Creative.creativeKey`는 “사용자 관찰 단위”다. 두 개념을 섞으면 안 된다.

### 11.5 날짜 prefix와 세팅 suffix 저장

날짜 prefix와 IG/FB는 제거만 하지 말고 metadata로 남긴다.

이유:

- 사용자가 원본 광고 이름이 어떻게 들어왔는지 확인해야 한다.
- 추후 네이밍 규칙 점검 기능을 만들 수 있다.

## 12. 샘플 사용자 흐름

1. 사용자가 2026-06-03 Meta 광고 CSV를 업로드한다.
2. `버닝웨이브바_02`, `260602_버닝웨이브바_02` row가 들어온다.
3. 시스템은 두 이름 모두 `creativeKey = 버닝웨이브바_02`로 파싱한다.
4. `Creative(버닝웨이브바_02)`를 생성 또는 갱신한다.
5. 원본 광고 이름들은 `CreativeAlias`에 저장한다.
6. 각 row가 들어간 광고 세트는 `CreativePlacement`에 저장한다.
7. 날짜별 성과는 `MetaAdDailyMetric.creativeId`로 연결된다.
8. 사용자가 Change Logs 페이지에 들어간다.
9. 왼쪽 목록에 `[버닝웨이브바_02]` 박스가 보인다.
10. 클릭하면 오른쪽에 사용 세트, 원본 광고명, 날짜별 성과, 로그 타임라인이 보인다.
11. 사용자는 `WATCH` 버튼을 누르고 사유를 입력한다.
12. 로그는 `CreativeChangeLog`로 저장되고 소재 상세 타임라인에 표시된다.

## 13. 최종 완료 기준

기능 완료로 판단하려면 아래가 모두 충족되어야 한다.

- 광고 단위 CSV 업로드 시 Creative가 생성된다.
- 이름 정규화 규칙이 테스트로 검증된다.
- 날짜 prefix가 달라도 같은 제품명/소재번호면 같은 Creative로 묶인다.
- IG/FB/IG+FB suffix가 달라도 같은 Creative로 묶인다.
- 같은 Creative가 들어간 여러 광고 세트를 상세에서 확인할 수 있다.
- Change Logs 페이지 진입 시 소재 객체 텍스트박스 목록이 바로 보인다.
- 소재 박스를 클릭하면 상세 이력과 입력창이 보인다.
- 소재 단위 로그 저장이 가능하다.
- 로그는 세트/캠페인 객체가 아니라 Creative에 붙는다.
- 기존 광고 metric import, adset aggregate import가 깨지지 않는다.
- `npm.cmd run test`, `npm.cmd run build`, `npm.cmd run prisma:validate`가 통과한다.

