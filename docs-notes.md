# 参照している仕様メモ

- Azure OpenAI Realtime WebRTC: GA endpoint は `/openai/v1/realtime/client_secrets` と `/openai/v1/realtime/calls`。
- Azure OpenAI v1 API: `base_url` は `https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1/` または `https://YOUR-RESOURCE-NAME.services.ai.azure.com/openai/v1/` 形式を利用できる。
- three-vrm: HTMLでは importmap で `three`, `three/addons/`, `@pixiv/three-vrm` をCDNから読み込み、`GLTFLoader` に `VRMLoaderPlugin` を登録する。

このファイルはREADMEの補助です。正式な根拠は Microsoft Learn と pixiv/three-vrm のREADMEを確認してください。
