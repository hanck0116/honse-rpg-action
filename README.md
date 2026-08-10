# 혼세 RPG 상태·판정 서버

혼세 RPG Custom GPT와 플레이어 시트를 위한 Cloudflare Workers + D1 서버입니다. 기본 4인 파티를 포함해 1~8명의 캐릭터, 인벤토리, 스킬, 임무, 전투, 세계 상태, DLC와 모든 판정 기록을 저장합니다.

## 구현 범위

- 저장 슬롯 생성·조회·이름 변경·보관·복원
- 여러 캐릭터와 하위 아이템·스킬의 영구 저장
- 레벨 기반 6스탯 자동 재계산과 자동 승급
- 임무 게시판 10개 구성·초반 보호·급수별 전투/네임드 수 검증
- 임무 수락 시 GM 전용 불변 스냅샷과 참가자 잠금
- 임무 완료 시 참가자 전원 성장의 원자적 처리
- 난이도·상대·표 판정과 Web Crypto 균등 난수 기록
- 숨은 판정도 주사위 식·원시 결과·판정 결과는 공개하고 비밀 맥락만 차단
- 일반 몬스터·네임드 드롭과 고정 랜덤 박스 표
- 전투 피해·상태·제작·합성·아이템 이동·소모·부활·DLC를 위한 다중 엔티티 원자적 트랜잭션
- `public`/`discovered`와 `hidden`/`sealed`/`gm` 데이터 분리
- 해시된 읽기 전용 파티 접근 코드와 플레이어 사이트용 공개 API
- `action_id` 멱등성, `revision` 낙관적 잠금, 전체 행동 로그

## 데이터 모델

`game_entities`는 아래 상태를 공통 revision 규칙으로 저장합니다.

`character`, `item`, `skill`, `mission_board`, `mission`, `npc`, `monster`, `named`, `location`, `world`, `crisis`, `gimmick`, `hazard`, `combat`, `drop_table`, `dlc`, `note`

각 엔티티는 플레이어에게 보여도 되는 `public_json`과 GM만 읽는 `gm_json`을 분리합니다. 플레이어 API는 `public` 또는 `discovered` 엔티티와 공개용 판정 JSON만 반환하며 내부 ID, revision, GM JSON을 반환하지 않습니다.

## 주요 API

인증된 GM/GPT 요청은 `Authorization: Bearer <ACTION_API_KEY>`를 사용합니다.

| 메서드 | 경로 | 기능 |
|---|---|---|
| `GET/POST` | `/v1/save-slots` | 슬롯 목록·생성 |
| `GET` | `/v1/save-slots/{slot_id}` | 슬롯 조회 |
| `PATCH` | `/v1/save-slots/{slot_id}/title` | 이름 변경 |
| `POST` | `/v1/save-slots/{slot_id}/archive` | 삭제 없는 보관 |
| `POST` | `/v1/save-slots/{slot_id}/restore` | 슬롯 복원 |
| `GET/POST` | `/v2/slots/{slot_id}/entities` | 모든 게임 엔티티 목록·생성 |
| `GET/PATCH` | `/v2/slots/{slot_id}/entities/{entity_id}` | 엔티티 조회·수정 |
| `POST` | `/v2/slots/{slot_id}/transactions` | 1~40개 상태 변화를 한 번에 저장 |
| `POST` | `/v2/slots/{slot_id}/rolls/table` | 생성·표·보정용 주사위 |
| `POST` | `/v2/slots/{slot_id}/rolls/difficulty` | 난이도 판정 |
| `POST` | `/v2/slots/{slot_id}/rolls/opposed` | 상대 판정 |
| `POST` | `/v2/slots/{slot_id}/mission-boards` | 10개 임무 게시판 검증·잠금 |
| `POST` | `/v2/slots/{slot_id}/missions/accept` | 임무·참가자 불변 잠금 |
| `POST` | `/v2/slots/{slot_id}/missions/{mission_id}/complete` | 참가자 전원 성장·승급 |
| `POST` | `/v2/slots/{slot_id}/drops/resolve` | 고정 드롭 규칙 판정 |
| `POST` | `/v2/slots/{slot_id}/random-boxes/open` | 고정 랜덤 박스 표 굴림 |
| `POST` | `/v2/slots/{slot_id}/party-access/rotate` | 읽기 전용 접근 코드 발급·교체 |

플레이어 사이트는 `GET /public/party`에 `Authorization: Bearer <파티 접근 코드>`를 사용합니다. 이 코드는 GM API 키와 별개이며 읽기만 가능합니다.

상태 변경 요청은 새 `action_id`를 포함합니다. 같은 요청을 재시도할 때만 같은 ID를 재사용합니다. 기존 엔티티 변경에는 마지막 조회의 `expected_revision`이 필요합니다. `transactions`는 전투 결과, 여러 재료의 소모와 제작품 생성처럼 부분 저장이 허용되지 않는 변화를 처리합니다.

## 로컬 검증

```bash
npm install
cp .dev.vars.example .dev.vars
npm run cf-typegen
npm run db:migrate:local
npm run check
npm run deploy:dry-run
```

`.dev.vars`의 `ACTION_API_KEY`는 64자 이상의 무작위 값으로 바꾸고 커밋하지 않습니다.

## 배포

GitHub Actions의 `Deploy to Cloudflare` 워크플로가 검사, D1 마이그레이션, Worker Secret 등록과 배포를 수행합니다. 저장소에는 다음 Secret이 필요합니다.

| Secret | 용도 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | 대상 Cloudflare 계정 |
| `CLOUDFLARE_API_TOKEN` | 해당 계정의 Workers Scripts·D1 편집 |
| `ACTION_API_KEY` | Custom GPT Action 전용 Bearer 키 |

이 구성은 Workers/D1 무료 플랜에서 동작하며 유료 추적·로그 내보내기·별도 AI 서비스를 사용하지 않습니다.
