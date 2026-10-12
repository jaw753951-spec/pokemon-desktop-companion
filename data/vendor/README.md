# 저장소에 보관하는 외부 도트

에셋 빌드가 다른 사람의 GitHub 저장소에서 받아 쓰는 도트 중, **원본이 사라지거나 바뀌면 게임에서 그림이
빠지는 것**을 여기에 복사해 둡니다. 빌드는 이 폴더를 먼저 읽고, 원본에는 접속하지 않습니다.

| 폴더 | 원본 | 고정한 커밋 | 쓰는 곳 |
| --- | --- | --- | --- |
| `pokeapi/` | PokeAPI/sprites 의 `sprites/pokemon/versions/generation-v/black-white` | `a13b1f4c` | 모든 포켓몬 그림 — 1~649번은 블랙·화이트 공식 전투 도트, 이후와 리전폼·새 폼은 스모곤 커뮤니티의 BW 스타일 도트(평범·이로치·암컷·폼) |
| `smogon-sprites/` | smogon/sprites 의 `src/_uncategorized/…/trainers` | `bad55c7b` | 성도·하나 관장, 석영리그의 일목·카렌, 하나 사천왕의 원작 도트, 칼로스·알로라 사람들의 팬 도트 |
| `pokerogue/` | pagefaultgames/pokerogue-assets 의 `images/trainer` (CC BY-NC-SA 4.0) | `056a1f40` | 자크로·카르네·하우와 가라르·팔데아·블루베리 사람들 — 도트와 아틀라스(JSON), 첫 프레임을 씀 |
| `showdown-trainers/` | worlds-collide-showdown/sprites 의 `sprites/trainers` (포켓몬 쇼다운 트레이너 도트의 사본) | `908f9e57` | 세이버리·도정 |

파일은 원본 저장소에서의 경로 그대로 들어 있습니다.

## `index.json`

- `present` — 받아서 여기 보관한 파일
- `absent` — 원본에 물어봤지만 없던 파일(대부분 `female/` 그림이 없는 종). 네트워크 없이도 "없음"으로 답합니다.
- `commit` / `base` — 목록에 없는 파일이 새로 필요해질 때 받아 올 곳. 브랜치가 아니라 커밋으로 고정되어 있어,
  원본 저장소가 나중에 파일을 바꾸거나 지워도 같은 그림을 받습니다.

새로 필요한 파일이 생기면(예: 새 폼이 추가될 때) 빌드가 원본에서 받아 이 폴더와 `index.json` 에 추가하고,
로그에 `vendored …: N path(s) new to data/vendor/… — commit them` 을 남깁니다. 그 파일들을 커밋하면 됩니다.
원본에 접속할 수 없으면 아무것도 기록하지 않고, 다음 빌드에서 다시 묻습니다.

어떤 종이나 폼의 그림이든 빠지면 에셋 검증(`npm run assets -- --only verify`)이 실패합니다.

## 라이선스와 크레딧

1~649번의 도트는 포켓몬 블랙·화이트의 공식 도트이고, 그 밖의 것은 출처를 밝히는 조건으로 공개된 스모곤
스프라이트 프로젝트의 팬 작품입니다. 사람 도트 중 원작에 없는 것은 위 표의 팬 작품이며, PokéRogue 의 것은
CC BY-NC-SA 4.0 을 따릅니다(이 게임은 잘라서 쓰고, 같은 조건으로 둡니다). 게임의 **설정 → 크레딧** 탭이 PokeAPI가 적어 둔 작가 목록을 보여 줍니다.
포켓몬의 권리는 Nintendo / Creatures Inc. / GAME FREAK inc. 에 있습니다.
