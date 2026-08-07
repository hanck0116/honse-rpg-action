# 혼세 RPG Action 서버

혼세 RPG Custom GPT가 확정 상태를 저장하고 단순 계산을 위임할 수 있도록 만든 개인용 Cloudflare Worker입니다. 하나의 공유 채팅에서 여러 캐릭터가 플레이하며, 여러 저장 슬롯은 서로 완전히 분리됩니다.

현재 구현 범위는 기반 상태 엔진의 첫 단계입니다.

- API Key 인증
- 저장 슬롯 생성·목록·조회
- 저장 슬롯 이름 변경
- 삭제 없는 보관·복원
- `action_id` 중복 적용 방지
- `revision` 충돌 차단
- 상태 변경과 행동 로그의 원자적 기록

캐릭터 생성, 판정, 전투, 임무, 콘텐츠 검색은 아직 구현하지 않았습니다.

## 로컬 실행

```bash
npm install
cp .dev.vars.example .dev.vars
npm run cf-typegen
npm run db:migrate:local
npm test
npm run dev
```

`.dev.vars`의 `ACTION_API_KEY`는 충분히 긴 무작위 문자열로 교체하고 Git에 커밋하지 않습니다.

## API

`GET /health`만 인증 없이 호출할 수 있습니다. 나머지 요청에는 다음 헤더가 필요합니다.

```http
Authorization: Bearer <ACTION_API_KEY>
```

| 메서드 | 경로 | 기능 |
|---|---|---|
| `POST` | `/v1/save-slots` | 슬롯 생성 |
| `GET` | `/v1/save-slots` | 활성 슬롯 목록 |
| `GET` | `/v1/save-slots?include_archived=true` | 보관 슬롯 포함 목록 |
| `GET` | `/v1/save-slots/{slot_id}` | 슬롯 조회 |
| `PATCH` | `/v1/save-slots/{slot_id}/title` | 이름 변경 |
| `POST` | `/v1/save-slots/{slot_id}/archive` | 슬롯 보관 |
| `POST` | `/v1/save-slots/{slot_id}/restore` | 슬롯 복원 |

상태 변경 요청은 `action_id`를 반드시 포함합니다. 이름 변경·보관·복원에는 마지막 조회에서 받은 `expected_revision`도 필요합니다. 같은 `action_id`와 같은 요청을 다시 보내면 저장된 응답을 그대로 반환하고, 같은 ID에 다른 내용을 보내면 거부합니다.

## Cloudflare 배포 전 준비

이번 단계에서는 실제 배포를 수행하지 않습니다. 다음 단계에서 Cloudflare 계정에 D1을 만들고 설정을 확정한 뒤 아래 순서로 진행합니다.

```bash
npx wrangler d1 create honse-rpg-action
npx wrangler d1 migrations apply honse-rpg-action --remote
npx wrangler secret put ACTION_API_KEY
npm run deploy:dry-run
npx wrangler deploy
```

D1 생성 결과의 `database_id`를 `wrangler.jsonc`에 반영해야 합니다.

