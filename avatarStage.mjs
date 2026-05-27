import {
  STAGE_BUBBLE_AVATAR_GAP_PX,
  STAGE_BUBBLE_EDGE_INSET_PX,
  STAGE_TRANSCRIPT_LIMIT,
  calculateStageBubbleMaxWidth,
  calculateVROriginFromBounds,
  calculateVRPanelDepth,
  calculateVRTextCanvasMetrics,
  drawBubbleShape,
  fitCanvasText,
  getRendererProfile,
  normalizeStageText,
  setCanvasTextFont,
  wrapCanvasText
} from './avatarStageUtils.mjs';

export {
  calculateStageBubbleMaxWidth,
  calculateVROriginFromBounds,
  calculateVRPanelDepth,
  calculateVRTextCanvasMetrics,
  drawBubbleShape,
  fitCanvasText,
  getRendererProfile,
  normalizeStageText,
  wrapCanvasText
} from './avatarStageUtils.mjs';

const AVATAR_VRM_URL = './assets/8590256991748008892.lite-2048-1024.vrm';
const AVATAR_VRMA_URL = './assets/relaxed_stand_idle_1s_skeleton_only_human_breath.vrma';
const OFFICE_BACKGROUND_URL = './assets/minimal_office_background_v2_fixed_unlit.glb';
const STAGE_CAMERA_FOV = 30;
const STAGE_CAMERA_POSITION = Object.freeze({ x: 0, y: 1.35, z: 3.1 });
const STAGE_CAMERA_TARGET = Object.freeze({ x: 0, y: 1.25, z: 0 });
const AVATAR_STAGE_POSITION = Object.freeze({ x: 0, y: 0, z: 0 });
const OFFICE_BACKGROUND_POSITION = Object.freeze({ x: 0, y: 0, z: -0.55 });
const OFFICE_BACKGROUND_SCALE = 1;
const FORCE_OFFICE_BACKGROUND_BASIC_MATERIAL = false;
const VR_FLOOR_EDGE_MARGIN = 0.55;
const VR_DEFAULT_ORIGIN_X = 0;
const VR_DEFAULT_ORIGIN_Z = 3.1;
const VR_AVATAR_BUBBLE_DEFAULT_WIDTH = 0.82;
const VR_AVATAR_BUBBLE_MIN_WIDTH = 0.34;
const VR_AVATAR_BUBBLE_DEFAULT_X = -0.82;
const VR_AVATAR_BUBBLE_DEFAULT_Z = 0.06;
const VR_FACE_RAY_CLEARANCE = 0.16;

let THREE = null;
let GLTFLoader = null;
let OrbitControls = null;
let VRButton = null;
let VRMLoaderPlugin = null;
let THREE_VRM = null;
let createVRMAnimationClip = null;
let VRMAnimationLoaderPlugin = null;
let VRMLookAtQuaternionProxy = null;

export function createAvatarStage({
  elements,
  onAdvice = () => {},
  onDiagnosticEvent = () => {},
  onLoadingChange = () => {},
  onVRSessionRequested = () => {},
  onVRSessionStart = () => {}
} = {}) {
  const els = elements || {};
  const state = {
    renderer: null,
    scene: null,
    camera: null,
    cameraRig: null,
    controls: null,
    resizeObserver: null,
    frontKeyLight: null,
    fallbackFloor: null,
    officeBackground: null,
    officeFloorWorldBox: null,
    vrConversationGroup: null,
    vrHudGroup: null,
    vrConversationMeshes: [],
    vrAdviceMesh: null,
    latestVRAdviceText: 'アドバイス',
    initialBubbleLayoutReady: false,
    vrAvatarBubbleWidth: VR_AVATAR_BUBBLE_DEFAULT_WIDTH,
    vrAvatarBubbleX: VR_AVATAR_BUBBLE_DEFAULT_X,
    vrm: null,
    animationMixer: null,
    clock: null,
    cameraWorldPosition: null,
    blinkTimer: 0.4 + Math.random() * 1.6,
    blinkProgress: 0,
    blinkDuration: 0.12,
    mouthTimer: 0,
    mouthValue: 0,
    mouthExpressionIndex: 0,
    audioContext: null,
    lipSource: null,
    lipAnalyser: null,
    lipData: null,
    avatarSpeaking: false,
    conversation: [],
    rendererProfile: null,
    avatarLoading: true,
    avatarLoadingText: 'アバターを読み込んでいます'
  };

  async function init() {
    await loadRenderingModules();
    initScene();
  }

  function initScene() {
    if (!els.stage || state.renderer) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x10151f);

    const cameraRig = new THREE.Group();
    cameraRig.name = 'stageCameraRig';
    scene.add(cameraRig);

    const camera = new THREE.PerspectiveCamera(STAGE_CAMERA_FOV, 1, 0.1, 100);
    resetStageCamera(camera, cameraRig);
    cameraRig.add(camera);

    const rendererProfile = getRendererProfile({
      userAgent: navigator.userAgent || '',
      deviceMemory: navigator.deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency
    });
    const renderer = new THREE.WebGLRenderer({
      antialias: rendererProfile.antialias,
      alpha: false,
      powerPreference: 'high-performance',
      precision: rendererProfile.precision
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, rendererProfile.maxPixelRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    renderer.xr.setFramebufferScaleFactor?.(rendererProfile.xrFramebufferScaleFactor);
    els.stage.appendChild(renderer.domElement);
    const vrButton = VRButton.createButton(renderer);
    vrButton.classList.add('stageVrButton');
    vrButton.addEventListener('click', handleVRButtonClick, { capture: true });
    els.stage.appendChild(vrButton);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(STAGE_CAMERA_TARGET.x, STAGE_CAMERA_TARGET.y, STAGE_CAMERA_TARGET.z);
    controls.enableDamping = true;
    controls.minDistance = 1.5;
    controls.maxDistance = 6;
    renderer.xr.addEventListener('sessionstart', handleXRSessionStart);
    renderer.xr.addEventListener('sessionend', handleXRSessionEnd);

    setupAvatarLighting(scene, camera);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(1.65, 64),
      new THREE.MeshStandardMaterial({ color: 0x1b2434, roughness: 0.85 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    scene.add(floor);

    Object.assign(state, {
      scene,
      camera,
      cameraRig,
      renderer,
      rendererProfile,
      controls,
      fallbackFloor: floor,
      clock: new THREE.Clock(),
      cameraWorldPosition: new THREE.Vector3()
    });
    setupVRTextPanels(scene, camera);
    loadOfficeBackground(OFFICE_BACKGROUND_URL, floor);

    window.addEventListener('resize', resizeStageRenderer);
    if ('ResizeObserver' in window) {
      state.resizeObserver = new ResizeObserver(resizeStageRenderer);
      state.resizeObserver.observe(els.stage);
    }
    resizeStageRenderer();

    void loadVRM(AVATAR_VRM_URL);
    renderer.setAnimationLoop(renderLoop);
  }

  function setLoading(loading, text = '') {
    state.avatarLoading = Boolean(loading);
    if (text) state.avatarLoadingText = text;
    onLoadingChange(state.avatarLoading, state.avatarLoadingText);
    if (!els.stageLoading) return;
    const visible = state.avatarLoading && Boolean(state.avatarLoadingText);
    if (els.stageLoadingText && state.avatarLoadingText) els.stageLoadingText.textContent = state.avatarLoadingText;
    els.stageLoading.classList.toggle('is-hidden', !visible);
    els.stageLoading.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function setStatus(text) {
    if (els.avatarStatus) els.avatarStatus.textContent = text;
  }

  function resetStageCamera(camera, cameraRig) {
    if (cameraRig) {
      cameraRig.position.set(0, 0, 0);
      cameraRig.rotation.set(0, 0, 0);
      cameraRig.scale.set(1, 1, 1);
      cameraRig.updateMatrixWorld(true);
    }
    camera.fov = STAGE_CAMERA_FOV;
    camera.near = 0.1;
    camera.far = 100;
    camera.position.set(STAGE_CAMERA_POSITION.x, STAGE_CAMERA_POSITION.y, STAGE_CAMERA_POSITION.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(STAGE_CAMERA_TARGET.x, STAGE_CAMERA_TARGET.y, STAGE_CAMERA_TARGET.z);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  function handleXRSessionStart() {
    onVRSessionStart();
    if (state.controls) state.controls.enabled = false;
    if (!state.cameraRig) return;
    const vrOrigin = calculateVROriginPosition();
    state.cameraRig.position.copy(vrOrigin);
    state.cameraRig.rotation.set(0, 0, 0);
    state.cameraRig.scale.set(1, 1, 1);
    state.cameraRig.updateMatrixWorld(true);
  }

  function handleVRButtonClick() {
    if (state.renderer?.xr?.isPresenting) return;
    if (!/ENTER\s+VR/i.test(this?.textContent || '')) return;
    onVRSessionRequested();
  }

  function handleXRSessionEnd() {
    if (!state.camera) return;
    resetStageCamera(state.camera, state.cameraRig);
    if (state.controls) {
      state.controls.enabled = true;
      state.controls.target.set(STAGE_CAMERA_TARGET.x, STAGE_CAMERA_TARGET.y, STAGE_CAMERA_TARGET.z);
      state.controls.update();
    }
    resizeStageRenderer();
  }

  function resize() {
    requestAnimationFrame(() => {
      resizeStageRenderer();
      scheduleInitialBubbleLayout();
      requestAnimationFrame(resizeStageRenderer);
    });
  }

  function resizeStageRenderer() {
    if (!state.renderer || !state.camera || !els.stage) return;
    if (state.renderer.xr?.isPresenting) return;
    const rect = els.stage.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (width <= 0 || height <= 0) return;

    state.renderer.setSize(width, height, false);
    state.camera.aspect = Math.max(width / height, 0.1);
    state.camera.updateProjectionMatrix();
    scheduleInitialBubbleLayout();
  }

  function scheduleInitialBubbleLayout() {
    if (state.initialBubbleLayoutReady) return;
    requestAnimationFrame(applyInitialBubbleLayout);
  }

  function applyInitialBubbleLayout() {
    if (state.initialBubbleLayoutReady) return;
    if (!els.stage || !state.vrm?.scene || !state.camera) return;

    const stageRect = els.stage.getBoundingClientRect();
    if (stageRect.width <= 0 || stageRect.height <= 0) return;

    state.camera.updateMatrixWorld(true);
    state.vrm.scene.updateMatrixWorld(true);
    const avatarRect = projectBoxToStage(getAvatarFaceProtectionBox(), state.camera, stageRect);
    if (!avatarRect) return;

    const assistantMaxWidth = calculateStageBubbleMaxWidth(avatarRect.left - STAGE_BUBBLE_AVATAR_GAP_PX - STAGE_BUBBLE_EDGE_INSET_PX);
    const userMaxWidth = calculateStageBubbleMaxWidth(stageRect.width - avatarRect.right - STAGE_BUBBLE_AVATAR_GAP_PX - STAGE_BUBBLE_EDGE_INSET_PX);
    els.stage.style.setProperty('--stage-assistant-bubble-max-width', `${assistantMaxWidth}px`);
    els.stage.style.setProperty('--stage-user-bubble-max-width', `${userMaxWidth}px`);

    const vrLayout = calculateInitialVRAvatarBubbleLayout();
    state.vrAvatarBubbleWidth = vrLayout.width;
    state.vrAvatarBubbleX = vrLayout.x;
    state.initialBubbleLayoutReady = true;
    updateVRConversationPanels();
  }

  function projectBoxToStage(box, camera, stageRect) {
    if (!Number.isFinite(box.min.x) || box.isEmpty()) return null;

    const corners = [
      new THREE.Vector3(box.min.x, box.min.y, box.min.z),
      new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      new THREE.Vector3(box.min.x, box.max.y, box.min.z),
      new THREE.Vector3(box.min.x, box.max.y, box.max.z),
      new THREE.Vector3(box.max.x, box.min.y, box.min.z),
      new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      new THREE.Vector3(box.max.x, box.max.y, box.min.z),
      new THREE.Vector3(box.max.x, box.max.y, box.max.z)
    ];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const corner of corners) {
      corner.project(camera);
      if (!Number.isFinite(corner.x) || !Number.isFinite(corner.y) || !Number.isFinite(corner.z)) continue;
      const x = (corner.x * 0.5 + 0.5) * stageRect.width;
      const y = (-corner.y * 0.5 + 0.5) * stageRect.height;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;

    return {
      left: Math.max(0, minX),
      top: Math.max(0, minY),
      right: Math.min(stageRect.width, maxX),
      bottom: Math.min(stageRect.height, maxY)
    };
  }

  function getAvatarFaceProtectionBox() {
    const avatarBox = new THREE.Box3().setFromObject(state.vrm.scene);
    if (!Number.isFinite(avatarBox.min.x) || avatarBox.isEmpty()) return avatarBox;

    const avatarSize = new THREE.Vector3();
    avatarBox.getSize(avatarSize);
    const center = getAvatarFacePoint();
    const halfX = Math.max(avatarSize.y * 0.09, 0.14);
    const halfY = Math.max(avatarSize.y * 0.11, 0.16);
    const halfZ = Math.max(avatarSize.y * 0.07, 0.1);
    return new THREE.Box3(
      new THREE.Vector3(center.x - halfX, center.y - halfY, center.z - halfZ),
      new THREE.Vector3(center.x + halfX, center.y + halfY, center.z + halfZ)
    );
  }

  function calculateInitialVRAvatarBubbleLayout() {
    const facePoint = getAvatarFacePoint();
    const cameraPoint = new THREE.Vector3(STAGE_CAMERA_POSITION.x, STAGE_CAMERA_POSITION.y, STAGE_CAMERA_POSITION.z);
    const rayDirection = facePoint.clone().sub(cameraPoint);
    const rayLengthSq = rayDirection.lengthSq();
    if (rayLengthSq <= 0.0001) {
      return { width: VR_AVATAR_BUBBLE_DEFAULT_WIDTH, x: VR_AVATAR_BUBBLE_DEFAULT_X };
    }

    const targetZ = VR_AVATAR_BUBBLE_DEFAULT_Z;
    const t = Math.abs(rayDirection.z) > 0.0001
      ? Math.max(0, Math.min(1, (targetZ - cameraPoint.z) / rayDirection.z))
      : 1;
    const rayXAtBubbleDepth = cameraPoint.x + rayDirection.x * t;
    const maxWidthBeforeRay = Math.max(
      VR_AVATAR_BUBBLE_MIN_WIDTH,
      (rayXAtBubbleDepth - VR_FACE_RAY_CLEARANCE - VR_AVATAR_BUBBLE_DEFAULT_X) * 2
    );
    const width = Math.min(VR_AVATAR_BUBBLE_DEFAULT_WIDTH, maxWidthBeforeRay);
    const maxCenterX = rayXAtBubbleDepth - VR_FACE_RAY_CLEARANCE - width / 2;
    const x = Math.min(VR_AVATAR_BUBBLE_DEFAULT_X, maxCenterX);
    return { width, x };
  }

  function getAvatarFacePoint() {
    const head = state.vrm?.humanoid?.getNormalizedBoneNode?.('head')
      || state.vrm?.humanoid?.getRawBoneNode?.('head');
    if (head) {
      const point = new THREE.Vector3();
      head.getWorldPosition(point);
      point.y += 0.06;
      return point;
    }

    const box = new THREE.Box3().setFromObject(state.vrm.scene);
    const center = new THREE.Vector3();
    box.getCenter(center);
    center.y = box.min.y + (box.max.y - box.min.y) * 0.82;
    return center;
  }

  function loadOfficeBackground(url, fallbackFloor) {
    const loader = new GLTFLoader();
    loader.load(url, (gltf) => {
      const background = gltf.scene;
      background.name = 'minimalOfficeBackground';
      background.scale.setScalar(OFFICE_BACKGROUND_SCALE);
      background.position.set(
        OFFICE_BACKGROUND_POSITION.x,
        OFFICE_BACKGROUND_POSITION.y,
        OFFICE_BACKGROUND_POSITION.z
      );
      tuneOfficeBackground(background);
      alignOfficeBackgroundFloor(background);
      state.officeFloorWorldBox = getOfficeFloorWorldBox(background);
      logOfficeBackgroundBounds(background);
      state.scene.add(background);
      state.officeBackground = background;
      if (fallbackFloor) fallbackFloor.visible = false;
    }, undefined, (error) => {
      console.warn('Office background load failed:', error);
    });
  }

  function alignOfficeBackgroundFloor(background) {
    background.updateMatrixWorld(true);
    const floor = background.getObjectByName('floor');
    if (!floor) return;
    const floorBox = new THREE.Box3().setFromObject(floor);
    if (!Number.isFinite(floorBox.max.y)) return;
    background.position.y += AVATAR_STAGE_POSITION.y - floorBox.max.y;
    background.updateMatrixWorld(true);
  }

  function getOfficeFloorWorldBox(background) {
    const floor = background?.getObjectByName?.('floor');
    if (!floor) return null;

    background.updateMatrixWorld(true);
    floor.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(floor);

    if (
      !Number.isFinite(box.min.x) ||
      !Number.isFinite(box.min.y) ||
      !Number.isFinite(box.min.z) ||
      !Number.isFinite(box.max.x) ||
      !Number.isFinite(box.max.y) ||
      !Number.isFinite(box.max.z) ||
      box.isEmpty()
    ) {
      return null;
    }

    return box;
  }

  function logOfficeBackgroundBounds(background) {
    if (!background) return;

    const roomBox = new THREE.Box3().setFromObject(background);
    const floor = background.getObjectByName('floor');
    const floorBox = floor ? new THREE.Box3().setFromObject(floor) : null;

    console.info('[office background] room bounds', {
      min: roomBox.min.toArray(),
      max: roomBox.max.toArray()
    });

    if (floorBox) {
      console.info('[office background] floor bounds', {
        min: floorBox.min.toArray(),
        max: floorBox.max.toArray()
      });
    }
  }

  function calculateVROriginPosition() {
    const floorBox = state.officeFloorWorldBox;

    if (!floorBox || floorBox.isEmpty()) {
      return new THREE.Vector3(
        VR_DEFAULT_ORIGIN_X,
        0,
        VR_DEFAULT_ORIGIN_Z
      );
    }

    const origin = calculateVROriginFromBounds({
      minX: floorBox.min.x,
      maxX: floorBox.max.x,
      minZ: floorBox.min.z,
      maxZ: floorBox.max.z,
      preferredX: VR_DEFAULT_ORIGIN_X,
      preferredZ: VR_DEFAULT_ORIGIN_Z,
      margin: VR_FLOOR_EDGE_MARGIN
    });

    return new THREE.Vector3(origin.x, origin.y, origin.z);
  }

  function tuneOfficeBackground(root) {
    root.traverse((object) => {
      if (!object.isMesh) return;
      object.frustumCulled = false;
      object.castShadow = false;
      object.receiveShadow = false;
      if (FORCE_OFFICE_BACKGROUND_BASIC_MATERIAL) {
        convertOfficeMeshToBasicMaterial(object);
      }
    });
  }

  function convertOfficeMeshToBasicMaterial(object) {
    const sourceMaterials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    const converted = sourceMaterials.map((sourceMaterial) => {
      const hasVertexColors = Boolean(object.geometry?.attributes?.color);
      const color = sourceMaterial?.color
        ? sourceMaterial.color.clone()
        : new THREE.Color(0xffffff);

      return new THREE.MeshBasicMaterial({
        name: sourceMaterial?.name
          ? `${sourceMaterial.name}_basicFallback`
          : `${object.name || 'office'}_basicFallback`,
        color,
        vertexColors: hasVertexColors,
        side: THREE.DoubleSide,
        toneMapped: false,
        depthTest: true,
        depthWrite: true
      });
    });

    object.material = Array.isArray(object.material) ? converted : converted[0];
  }

  async function loadVRM(url) {
    setLoading(true, 'アバターを読み込んでいます');
    setStatus('avatar: loading VRM');
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const startedAt = performance.now();
    emitAvatarLoadEvent('start', { url, rendererProfile: state.rendererProfile });
    try {
      const { arrayBuffer, bytes } = await fetchArrayBufferWithProgress(url, (loaded, total) => {
        if (!total) {
          setStatus('avatar: downloading');
          return;
        }
        const pct = Math.round((loaded / total) * 100);
        setStatus(`avatar: downloading ${pct}%`);
        setLoading(true, `アバターを読み込んでいます (${pct}%)`);
      });
      const downloadedAt = performance.now();
      setStatus('avatar: parsing VRM');
      setLoading(true, 'アバターを展開しています');
      const gltf = await parseGltf(loader, arrayBuffer, url);
      const parsedAt = performance.now();
      const vrm = gltf.userData.vrm;
      if (!vrm) throw new Error('VRM not found in glTF userData.');
      optimizeLoadedVRM(vrm);
      THREE_VRM.VRMUtils?.rotateVRM0?.(vrm);
      state.scene.add(vrm.scene);
      state.vrm = vrm;
      tuneAvatarMaterials(vrm.scene);
      fitVRM(vrm);
      addLookAtProxy(vrm);
      scheduleInitialBubbleLayout();
      setStatus('avatar: ready');
      setMood('neutral');
      const readyAt = performance.now();
      emitAvatarLoadEvent('ready', {
        url,
        bytes,
        downloadMs: Math.round(downloadedAt - startedAt),
        parseMs: Math.round(parsedAt - downloadedAt),
        postprocessMs: Math.round(readyAt - parsedAt),
        totalMs: Math.round(readyAt - startedAt),
        rendererProfile: state.rendererProfile
      });
      void loadVRMA(AVATAR_VRMA_URL, vrm);
    } catch (error) {
      console.error(error);
      setLoading(false);
      setStatus('avatar: load failed');
      emitAvatarLoadEvent('failed', {
        url,
        totalMs: Math.round(performance.now() - startedAt),
        message: error.message || String(error)
      });
      onAdvice('app', `VRMの読み込みに失敗しました: ${error.message || error}`, 'risk');
    }
  }

  async function loadVRMA(url, vrm) {
    setLoading(true, 'アバターの待機モーションを読み込んでいます');
    setStatus('avatar: loading animation');
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const startedAt = performance.now();
    try {
      const { arrayBuffer, bytes } = await fetchArrayBufferWithProgress(url, (loaded, total) => {
        if (!total) return;
        const pct = Math.round((loaded / total) * 100);
        setStatus(`avatar: animation ${pct}%`);
        setLoading(true, `アバターの待機モーションを読み込んでいます (${pct}%)`);
      });
      const downloadedAt = performance.now();
      const gltf = await parseGltf(loader, arrayBuffer, url);
      const vrmAnimation = gltf.userData.vrmAnimations?.[0];
      if (!vrmAnimation) throw new Error('VRMA not found in glTF userData.');
      const clip = createVRMAnimationClip(vrmAnimation, vrm);
      state.animationMixer?.stopAllAction();
      state.animationMixer = new THREE.AnimationMixer(vrm.scene);
      state.animationMixer
        .clipAction(clip)
        .reset()
        .setLoop(THREE.LoopRepeat, Infinity)
        .play();
      vrm.humanoid?.resetNormalizedPose?.();
      setStatus('avatar: ready + reading loop');
      setLoading(false);
      emitAvatarLoadEvent('animation_ready', {
        url,
        bytes,
        downloadMs: Math.round(downloadedAt - startedAt),
        parseMs: Math.round(performance.now() - downloadedAt),
        totalMs: Math.round(performance.now() - startedAt)
      });
    } catch (error) {
      console.error(error);
      setLoading(false);
      setStatus('avatar: ready, animation failed');
      emitAvatarLoadEvent('animation_failed', {
        url,
        totalMs: Math.round(performance.now() - startedAt),
        message: error.message || String(error)
      });
      onAdvice('app', `VRMAの読み込みに失敗しました: ${error.message || error}`, 'warn');
    }
  }

  function optimizeLoadedVRM(vrm) {
    const utils = THREE_VRM.VRMUtils;
    utils?.removeUnnecessaryVertices?.(vrm.scene);
    utils?.combineSkeletons?.(vrm.scene);
    utils?.combineMorphs?.(vrm);
  }

  function emitAvatarLoadEvent(stage, detail = {}) {
    onDiagnosticEvent({
      type: 'client.avatar_load',
      stage,
      ...detail
    });
  }

  function addLookAtProxy(vrm) {
    if (!vrm.lookAt || vrm.scene.getObjectByName('lookAtQuaternionProxy')) return;
    const lookAtQuatProxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
    lookAtQuatProxy.name = 'lookAtQuaternionProxy';
    vrm.scene.add(lookAtQuatProxy);
  }

  function setupAvatarLighting(scene, camera) {
    if (!camera.parent) scene.add(camera);

    const hemi = new THREE.HemisphereLight(0xf7f0ff, 0x243045, 0.48);
    scene.add(hemi);

    const frontKey = new THREE.DirectionalLight(0xfff1df, 3.25);
    frontKey.position.copy(camera.position);
    frontKey.target.position.set(0, 1.18, 0);
    scene.add(frontKey);
    scene.add(frontKey.target);

    const cameraFill = new THREE.PointLight(0xffe6d2, 0.95, 5, 1.25);
    cameraFill.position.set(0, 0, 0);
    camera.add(cameraFill);

    const rim = new THREE.DirectionalLight(0xb9ccff, 0.8);
    rim.position.set(-1.8, 2.5, -1.9);
    rim.target.position.set(0, 1.05, 0);
    scene.add(rim);
    scene.add(rim.target);

    state.frontKeyLight = frontKey;
  }

  function syncCameraLighting() {
    if (!state.frontKeyLight || !state.camera) return;
    state.camera.getWorldPosition(state.cameraWorldPosition);
    state.frontKeyLight.position.copy(state.cameraWorldPosition);
  }

  function tuneAvatarMaterials(root) {
    root.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        material.toneMapped = false;
        if ('roughness' in material) material.roughness = Math.max(material.roughness ?? 0.85, 0.9);
        if ('metalness' in material) material.metalness = 0;
        if ('envMapIntensity' in material) material.envMapIntensity = Math.min(material.envMapIntensity ?? 0.2, 0.2);
        if ('shadingShiftFactor' in material) material.shadingShiftFactor = -0.08;
        if ('shadingToonyFactor' in material) material.shadingToonyFactor = 0.92;
        if ('rimLightingMixFactor' in material) material.rimLightingMixFactor = 0.25;
        material.needsUpdate = true;
      }
    });
  }

  function fitVRM(vrm) {
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const scale = 1.6 / Math.max(size.y, 0.1);
    vrm.scene.scale.setScalar(scale);
    vrm.scene.updateMatrixWorld(true);

    const scaledBox = new THREE.Box3().setFromObject(vrm.scene);
    const center = new THREE.Vector3();
    scaledBox.getCenter(center);
    vrm.scene.position.x += AVATAR_STAGE_POSITION.x - center.x;
    vrm.scene.position.y += AVATAR_STAGE_POSITION.y - scaledBox.min.y;
    vrm.scene.position.z += AVATAR_STAGE_POSITION.z - center.z;
    vrm.scene.updateMatrixWorld(true);
  }

  function setupVRTextPanels(scene, camera) {
    const conversationGroup = new THREE.Group();
    conversationGroup.name = 'vrConversationBubbles';
    conversationGroup.visible = false;
    scene.add(conversationGroup);

    const hudGroup = new THREE.Group();
    hudGroup.name = 'vrConversationHud';
    hudGroup.visible = false;
    camera.add(hudGroup);

    state.vrConversationGroup = conversationGroup;
    state.vrHudGroup = hudGroup;
    updateVRConversationPanels();
    updateVRAdvicePanel(state.latestVRAdviceText);
  }

  function updateConversation(transcript) {
    state.conversation = Array.isArray(transcript) ? transcript.slice() : [];
    renderStageTranscript();
    updateVRConversationPanels();
  }

  function renderStageTranscript() {
    if (!els.stageChatOverlay) return;
    els.stageChatOverlay.innerHTML = '';
    for (const item of state.conversation.slice(-STAGE_TRANSCRIPT_LIMIT)) {
      const bubble = document.createElement('div');
      bubble.className = `stageTranscriptBubble ${item.role}`;
      bubble.textContent = normalizeStageText(item.text);
      els.stageChatOverlay.appendChild(bubble);
    }
  }

  function updateVRConversationPanels() {
    if (!state.vrConversationGroup || !state.vrHudGroup) return;
    clearVRConversationPanels();

    const visibleConversation = state.conversation.slice(-STAGE_TRANSCRIPT_LIMIT);
    const rolePanelCounts = visibleConversation.reduce((counts, item) => {
      const role = item.role === 'user' ? 'user' : 'assistant';
      counts[role] += 1;
      return counts;
    }, { user: 0, assistant: 0 });
    const rolePanelIndexes = { user: 0, assistant: 0 };
    let avatarRow = 0;
    let userRow = 0;
    for (const [globalIndex, item] of visibleConversation.entries()) {
      const role = item.role === 'user' ? 'user' : 'assistant';
      const rolePanelIndex = rolePanelIndexes[role];
      rolePanelIndexes[role] += 1;
      const avatarBubbleWidth = state.vrAvatarBubbleWidth || VR_AVATAR_BUBBLE_DEFAULT_WIDTH;
      const mesh = createVRTextPanel(normalizeStageText(item.text), {
        role,
        width: role === 'user' ? 0.82 : avatarBubbleWidth,
        height: 0.24,
        fontSize: 46,
        truncate: false,
        tail: role === 'user' ? 'user' : 'avatar',
        background: role === 'user' ? '#b8f20d' : '#f7f8f4',
        color: '#141820'
      });
      mesh.renderOrder = 30 + globalIndex;

      if (role === 'user') {
        mesh.position.set(
          0.48,
          0.25 - userRow * 0.22,
          calculateVRPanelDepth(-1.35, rolePanelIndex, rolePanelCounts.user)
        );
        state.vrHudGroup.add(mesh);
        userRow += 1;
      } else {
        mesh.position.set(
          state.vrAvatarBubbleX || VR_AVATAR_BUBBLE_DEFAULT_X,
          1.72 - avatarRow * 0.28,
          calculateVRPanelDepth(VR_AVATAR_BUBBLE_DEFAULT_Z, rolePanelIndex, rolePanelCounts.assistant)
        );
        mesh.userData.billboardToCamera = true;
        state.vrConversationGroup.add(mesh);
        avatarRow += 1;
      }
      state.vrConversationMeshes.push(mesh);
    }
  }

  function clearVRConversationPanels() {
    for (const mesh of state.vrConversationMeshes) {
      mesh.parent?.remove(mesh);
      disposeVRTextPanel(mesh);
    }
    state.vrConversationMeshes = [];
  }

  function setAdvice(text) {
    const displayText = normalizeStageText(text) || 'アドバイス';
    if (els.stageAdviceOverlay) els.stageAdviceOverlay.textContent = displayText;
    updateVRAdvicePanel(displayText);
  }

  function updateVRAdvicePanel(text) {
    state.latestVRAdviceText = text || 'アドバイス';
    if (!state.vrHudGroup) return;
    if (state.vrAdviceMesh) {
      state.vrHudGroup.remove(state.vrAdviceMesh);
      disposeVRTextPanel(state.vrAdviceMesh);
      state.vrAdviceMesh = null;
    }

    const mesh = createVRTextPanel(state.latestVRAdviceText, {
      role: 'advice',
      width: 1.48,
      height: 0.32,
      fontSize: 44,
      minFontSize: 28,
      maxLines: 4,
      fitText: true,
      truncate: false,
      tail: 'none',
      textAlign: 'left',
      background: '#fbfbf6',
      color: '#151922'
    });
    mesh.position.set(0, -0.43, calculateVRPanelDepth(-1.45, 0, 1));
    mesh.renderOrder = 40;
    state.vrHudGroup.add(mesh);
    state.vrAdviceMesh = mesh;
  }

  function createVRTextPanel(text, options) {
    const canvas = document.createElement('canvas');
    const canvasMetrics = calculateVRTextCanvasMetrics({
      panelWidth: options.width,
      panelHeight: options.height,
      textureScale: state.rendererProfile?.vrTextTextureScale
    });
    const { logicalWidth, canvasWidth, textureScale } = canvasMetrics;
    canvas.width = canvasWidth;
    let ctx = canvas.getContext('2d');
    const paddingX = 78;
    const paddingY = 38;
    const sideTail = options.tail === 'left' || options.tail === 'right';
    const bottomTail = options.tail === 'avatar' || options.tail === 'user';
    const tailSize = options.tail === 'none' ? 0 : 54;
    const bottomTailSize = bottomTail ? tailSize : 0;
    const rectX = options.tail === 'left' ? tailSize : 0;
    const rectWidth = logicalWidth - (sideTail ? tailSize : 0);
    const maxTextWidth = rectWidth - paddingX * 2;
    const maxLines = options.truncate === false
      ? Infinity
      : (Number.isFinite(options.maxLines) ? options.maxLines : (options.role === 'advice' ? 2 : 3));

    setCanvasTextFont(ctx, options.fontSize);
    const textLayout = options.fitText
      ? fitCanvasText(ctx, text, {
        maxWidth: maxTextWidth,
        maxLines,
        fontSize: options.fontSize,
        minFontSize: options.minFontSize || options.fontSize,
        truncate: options.truncate !== false
      })
      : {
        fontSize: options.fontSize,
        lines: wrapCanvasText(ctx, text, maxTextWidth, maxLines, options.truncate !== false)
      };
    const { fontSize, lines } = textLayout;
    const lineHeight = fontSize * 1.24;
    const bodyCanvasHeight = Math.max(canvasMetrics.minLogicalHeight, Math.ceil(paddingY * 2 + lines.length * lineHeight + 28));
    const logicalHeight = bodyCanvasHeight + bottomTailSize;
    canvas.height = Math.max(1, Math.round(logicalHeight * textureScale));
    ctx = canvas.getContext('2d');
    ctx.scale(textureScale, textureScale);
    ctx.clearRect(0, 0, logicalWidth, logicalHeight);
    ctx.fillStyle = options.background;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 10;
    drawBubbleShape(ctx, rectX + 8, 8, rectWidth - 16, bodyCanvasHeight - 24, 42, options.tail, tailSize);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.fillStyle = options.color;
    const textAlign = options.textAlign === 'left' ? 'left' : 'center';
    ctx.textAlign = textAlign;
    ctx.textBaseline = 'middle';
    setCanvasTextFont(ctx, fontSize);

    const textX = textAlign === 'left' ? rectX + paddingX : rectX + rectWidth / 2;
    const textBlockHeight = (lines.length - 1) * lineHeight;
    const textStartY = paddingY + (bodyCanvasHeight - paddingY * 2 - textBlockHeight) / 2;
    lines.forEach((line, index) => {
      ctx.fillText(line, textX, textStartY + index * lineHeight);
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = Math.min(4, state.renderer?.capabilities?.getMaxAnisotropy?.() || 1);
    texture.needsUpdate = true;

    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(options.width, options.width * (canvas.height / canvas.width)),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    mesh.userData.texture = texture;
    return mesh;
  }

  function disposeVRTextPanel(mesh) {
    mesh.geometry?.dispose();
    mesh.material?.map?.dispose?.();
    mesh.material?.dispose?.();
  }

  function syncVRTextPanels() {
    if (!state.renderer || !state.vrConversationGroup || !state.vrHudGroup) return;
    const presenting = state.renderer.xr.isPresenting;
    state.vrConversationGroup.visible = presenting;
    state.vrHudGroup.visible = presenting;
    if (!presenting) return;

    const xrCamera = state.renderer.xr.getCamera(state.camera) || state.camera;
    const cameraQuaternion = new THREE.Quaternion();
    xrCamera.getWorldQuaternion(cameraQuaternion);
    for (const mesh of state.vrConversationMeshes) {
      if (mesh.userData.billboardToCamera) mesh.quaternion.copy(cameraQuaternion);
    }
  }

  function syncXRCameraBeforeSceneSync() {
    if (!state.renderer?.xr?.isPresenting || !state.camera) return;
    if (typeof state.renderer.xr.updateCamera !== 'function') return;

    state.camera.parent?.updateMatrixWorld(true);
    state.renderer.xr.updateCamera(state.camera);
  }

  function renderLoop() {
    const delta = state.clock.getDelta();
    const isPresenting = Boolean(state.renderer?.xr?.isPresenting);
    if (!isPresenting) {
      state.controls?.update();
    }
    syncXRCameraBeforeSceneSync();
    syncCameraLighting();
    syncVRTextPanels();
    state.animationMixer?.update(delta);
    animateAvatar(delta);
    state.vrm?.update(delta);
    state.renderer.render(state.scene, state.camera);
  }

  function animateAvatar(delta) {
    const vrm = state.vrm;
    if (!vrm?.expressionManager) return;

    animateBlink(delta);
    animateMouth(delta);
  }

  function animateBlink(delta) {
    state.blinkTimer -= delta;
    if (state.blinkTimer > 0) return;

    state.blinkProgress += delta / state.blinkDuration;
    const blinkValue = Math.sin(Math.min(state.blinkProgress, 1) * Math.PI);
    setExpressionMany(['blink', 'Blink'], blinkValue);

    if (state.blinkProgress >= 1) {
      setExpressionMany(['blink', 'Blink'], 0);
      state.blinkProgress = 0;
      state.blinkDuration = 0.1 + Math.random() * 0.07;
      state.blinkTimer = 1.8 + Math.random() * 4.2;
    }
  }

  function animateMouth(delta) {
    const audioLevel = getAvatarAudioLevel();
    const talking = state.avatarSpeaking || audioLevel > 0.02;
    const target = talking ? Math.min(1, audioLevel * 2.8 + 0.08) : 0;
    state.mouthValue = THREE.MathUtils.lerp(state.mouthValue, target, talking ? 0.55 : 0.28);
    state.mouthTimer += delta;
    if (state.mouthTimer > 0.09) {
      state.mouthTimer = 0;
      state.mouthExpressionIndex = (state.mouthExpressionIndex + 1 + Math.floor(Math.random() * 2)) % 5;
    }
    setLipSyncExpressions(state.mouthValue, state.mouthExpressionIndex, talking);
  }

  function setLipSyncExpressions(level, expressionIndex, talking) {
    const damped = talking ? level : 0;
    const vowels = [
      { names: ['aa', 'A'], value: damped },
      { names: ['ih', 'I'], value: damped * 0.38 },
      { names: ['ee', 'E'], value: damped * 0.34 },
      { names: ['ou', 'U'], value: damped * 0.42 },
      { names: ['oh', 'O'], value: damped * 0.48 }
    ];
    for (let i = 0; i < vowels.length; i += 1) {
      const vowel = vowels[i];
      setExpressionMany(vowel.names, i === expressionIndex ? vowel.value : Math.min(vowel.value * 0.18, 0.16));
    }
  }

  function getAvatarAudioLevel() {
    const analyser = state.lipAnalyser;
    const data = state.lipData;
    if (!analyser || !data) return state.avatarSpeaking ? 0.18 + Math.random() * 0.18 : 0;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / data.length);
    return Number.isFinite(rms) ? rms : 0;
  }

  function setMood(mood) {
    const values = {
      neutral: { happy: 0.05, relaxed: 0.15, angry: 0, sad: 0 },
      listening: { happy: 0.1, relaxed: 0.2, angry: 0, sad: 0 },
      speaking: { happy: 0.18, relaxed: 0.12, angry: 0, sad: 0 },
      caution: { happy: 0, relaxed: 0.05, angry: 0.08, sad: 0.08 }
    }[mood] || {};
    for (const [name, value] of Object.entries(values)) setExpressionMany([name, capitalize(name)], value);
  }

  function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function setExpressionMany(names, value) {
    for (const name of names) setExpression(name, value);
  }

  function setExpression(name, value) {
    try {
      state.vrm?.expressionManager?.setValue(name, value);
    } catch {
      // Some VRM files do not expose every expression preset. Ignore silently.
    }
  }

  function attachLipSyncAudioStream(stream) {
    try {
      if (!ensureAudioContext()) return;
      state.lipSource?.disconnect?.();
      state.lipAnalyser = state.audioContext.createAnalyser();
      state.lipAnalyser.fftSize = 512;
      state.lipAnalyser.smoothingTimeConstant = 0.38;
      state.lipData = new Uint8Array(state.lipAnalyser.fftSize);
      state.lipSource = state.audioContext.createMediaStreamSource(stream);
      state.lipSource.connect(state.lipAnalyser);
    } catch (error) {
      console.warn('Lip sync analyser setup failed', error);
      state.lipSource = null;
      state.lipAnalyser = null;
      state.lipData = null;
    }
  }

  function ensureAudioContext() {
    if (!state.audioContext) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) return null;
      state.audioContext = new AudioContextCtor();
    }
    state.audioContext.resume?.();
    return state.audioContext;
  }

  function resetAudio() {
    try {
      state.lipSource?.disconnect?.();
    } catch {
      // Ignore disconnect races during WebRTC teardown.
    }
    state.lipSource = null;
    state.lipAnalyser = null;
    state.lipData = null;
    state.mouthValue = 0;
    if (THREE) setLipSyncExpressions(0, state.mouthExpressionIndex, false);
  }

  function setAvatarSpeaking(speaking) {
    state.avatarSpeaking = Boolean(speaking);
  }

  return {
    init,
    setMood,
    setAdvice,
    updateConversation,
    attachLipSyncAudioStream,
    ensureAudioContext,
    resetAudio,
    resize,
    setAvatarSpeaking
  };
}

async function loadRenderingModules() {
  if (THREE) return;
  const [threeModule, gltfModule, controlsModule, vrButtonModule, vrmModule, vrmAnimationModule] = await Promise.all([
    import('three'),
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/controls/OrbitControls.js'),
    import('three/addons/webxr/VRButton.js'),
    import('@pixiv/three-vrm'),
    import('@pixiv/three-vrm-animation')
  ]);
  THREE = threeModule;
  GLTFLoader = gltfModule.GLTFLoader;
  OrbitControls = controlsModule.OrbitControls;
  VRButton = vrButtonModule.VRButton;
  VRMLoaderPlugin = vrmModule.VRMLoaderPlugin;
  THREE_VRM = vrmModule;
  createVRMAnimationClip = vrmAnimationModule.createVRMAnimationClip;
  VRMAnimationLoaderPlugin = vrmAnimationModule.VRMAnimationLoaderPlugin;
  VRMLookAtQuaternionProxy = vrmAnimationModule.VRMLookAtQuaternionProxy;
}

async function fetchArrayBufferWithProgress(url, onProgress = () => {}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to fetch ${url}: ${response.status}`);

  const total = Number(response.headers.get('Content-Length')) || 0;
  if (!response.body?.getReader) {
    const arrayBuffer = await response.arrayBuffer();
    onProgress(arrayBuffer.byteLength, total || arrayBuffer.byteLength);
    return { arrayBuffer, bytes: arrayBuffer.byteLength };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }

  const output = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { arrayBuffer: output.buffer, bytes: loaded };
}

function parseGltf(loader, arrayBuffer, url) {
  const baseUrl = new URL(url, window.location.href);
  const resourcePath = baseUrl.href.slice(0, baseUrl.href.lastIndexOf('/') + 1);
  return new Promise((resolve, reject) => {
    loader.parse(arrayBuffer, resourcePath, resolve, reject);
  });
}
