// src/visualizer/gui/ViewCube.ts
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface ViewCubeOptions {
    size?: number;
    position?: { top: number; right: number };
    opacity?: number;
}

/**
 * The cube's colours. Every face is the same neutral colour, so the cube does not compete
 * with the axis colours in the scene; the lighting tells the faces apart.
 */
const FACE_COLOR = 0xe3e8ef;
const FACE_TEXT_COLOR = '#2b323d';
const FACE_BORDER_COLOR = '#aab4c3';

/** Names of the six standard views, as shown on the cube's faces. */
export type ViewName = 'Right' | 'Left' | 'Top' | 'Bottom' | 'Front' | 'Back';

/**
 * A small orientation cube in the corner of the window. It turns with the main camera, and
 * clicking a face moves the main camera to look at the scene from that side.
 *
 * The cube does not run its own render loop: call `render()` once per frame from the main
 * loop, and `dispose()` when the view is torn down.
 */
export class ViewCube {
    private scene!: THREE.Scene;
    private camera!: THREE.OrthographicCamera;
    private renderer!: THREE.WebGLRenderer;
    private cube!: THREE.Mesh<THREE.BoxGeometry, THREE.MeshLambertMaterial[]>;
    private canvas!: HTMLCanvasElement;
    private raycaster: THREE.Raycaster;
    private mouse: THREE.Vector2;
    private mainCamera: THREE.PerspectiveCamera;
    private mainControls: OrbitControls;
    private size: number;
    /** Pending frame of the camera move animation, or null when none is running. */
    private cameraAnimationFrame: number | null = null;

    /**
     * The six faces, indexed by the cube's material index.
     *
     * BoxGeometry orders its material groups +X, -X, +Y, -Y, +Z, -Z for a Y-up box. The
     * scene is Z-up, so `setupCube` rotates the geometry a quarter turn about X; after that
     * the groups face +X, -X, +Z, -Z, -Y, +Y, which is the order below. `direction` is the
     * side of the scene the camera goes to when the face is clicked.
     */
    private faces: { name: ViewName; color: number; direction: THREE.Vector3 }[] = [
        { name: 'Right', color: FACE_COLOR, direction: new THREE.Vector3(1, 0, 0) },
        { name: 'Left', color: FACE_COLOR, direction: new THREE.Vector3(-1, 0, 0) },
        { name: 'Top', color: FACE_COLOR, direction: new THREE.Vector3(0, 0, 1) },
        { name: 'Bottom', color: FACE_COLOR, direction: new THREE.Vector3(0, 0, -1) },
        { name: 'Front', color: FACE_COLOR, direction: new THREE.Vector3(0, -1, 0) },
        { name: 'Back', color: FACE_COLOR, direction: new THREE.Vector3(0, 1, 0) }
    ];

    /**
     * @param mainCamera - The camera of the main view.
     * @param mainControls - The orbit controls of the main view.
     * @param options - Size and position of the cube.
     */
    constructor(
        mainCamera: THREE.PerspectiveCamera,
        mainControls: OrbitControls,
        options: ViewCubeOptions = {}
    ) {
        this.mainCamera = mainCamera;
        this.mainControls = mainControls;
        this.size = options.size || 120;

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        this.setupCanvas(options);
        this.setupScene();
        this.setupCube();
        this.setupEventListeners();
    }

    /** Creates the cube's canvas and places it in the corner of the window. */
    private setupCanvas(options: ViewCubeOptions) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.size;
        this.canvas.height = this.size;
        // Position and frame come from the `.view-cube` rule in style.css.
        this.canvas.className = 'view-cube';
        if (options.position) {
            this.canvas.style.top = `${options.position.top}px`;
            this.canvas.style.right = `${options.position.right}px`;
        }
        this.canvas.title = 'View cube: click a face to look at the scene from that side';

        document.body.appendChild(this.canvas);
    }

    /** Creates the cube's own scene, camera, renderer and lights. */
    private setupScene() {
        this.scene = new THREE.Scene();

        // Setup orthographic camera
        const aspect = 1;
        const frustumSize = 3;
        this.camera = new THREE.OrthographicCamera(
            -frustumSize * aspect / 2, frustumSize * aspect / 2,
            frustumSize / 2, -frustumSize / 2,
            0.1, 100
        );
        this.camera.position.set(4, 4, 4);
        this.camera.up.set(0, 0, 1);
        this.camera.lookAt(0, 0, 0);

        // Setup renderer
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            alpha: true,
            antialias: true
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(this.size, this.size);
        this.renderer.setClearColor(0x000000, 0);

        // Add lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(5, 5, 5);
        this.scene.add(directionalLight);
    }

    /**
     * Draws a face's name on its colour, for use as the face's texture.
     *
     * @param name - The text to draw.
     * @param color - The face colour.
     * @returns The texture, or null if a 2D canvas is not available.
     */
    private createFaceTexture(name: string, color: number): THREE.CanvasTexture | null {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const context = canvas.getContext('2d');
        if (!context) return null;

        context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
        context.fillRect(0, 0, canvas.width, canvas.height);
        // A border on every face draws the cube's edges.
        context.strokeStyle = FACE_BORDER_COLOR;
        context.lineWidth = 6;
        context.strokeRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = FACE_TEXT_COLOR;
        context.font = '600 28px "Inter", "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Arial, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(name, canvas.width / 2, canvas.height / 2);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
    }

    /** Creates the cube with one labelled, coloured material per face. */
    private setupCube() {
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        // Turn the Y-up box into a Z-up one so the material groups match `faces`
        // (and the side labels stand upright along Z).
        geometry.rotateX(Math.PI / 2);

        const materials = this.faces.map(face => {
            const texture = this.createFaceTexture(face.name, face.color);
            return texture
                ? new THREE.MeshLambertMaterial({ map: texture })
                : new THREE.MeshLambertMaterial({ color: face.color });
        });

        this.cube = new THREE.Mesh(geometry, materials);
        this.scene.add(this.cube);
    }

    /** Hooks up clicking and hovering on the cube. */
    private setupEventListeners() {
        this.canvas.addEventListener('click', this.handleClick);
        this.canvas.addEventListener('mousemove', this.handleMouseMove);
    }

    /**
     * Finds the cube face under a mouse event.
     *
     * @param event - A mouse event on the cube's canvas.
     * @returns The index into `faces`, or null if the pointer is not over the cube.
     */
    private pickFace(event: MouseEvent): number | null {
        const rect = this.canvas.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObject(this.cube);
        const materialIndex = intersects[0]?.face?.materialIndex;
        return materialIndex === undefined ? null : materialIndex;
    }

    private handleClick = (event: MouseEvent) => {
        const faceIndex = this.pickFace(event);
        if (faceIndex !== null && this.faces[faceIndex]) {
            this.setView(this.faces[faceIndex].name);
        }
    };

    private handleMouseMove = (event: MouseEvent) => {
        // highlight the cube while a face is hovered
        this.canvas.style.filter = this.pickFace(event) !== null ? 'brightness(1.12)' : 'brightness(1)';
    };

    /**
     * Moves the main camera to one of the six standard views, keeping its distance to the
     * orbit target.
     *
     * @param view - The side to look from, e.g. 'Top' to look straight down.
     * @param distance - How far from the orbit target the camera ends up. Defaults to its
     *                   current distance.
     */
    public setView(view: ViewName, distance?: number) {
        const face = this.faces.find(f => f.name === view);
        if (!face) return;

        distance = distance ?? Math.max(
            this.mainControls.object.position.distanceTo(this.mainControls.target),
            50
        );

        const newPosition = face.direction.clone().multiplyScalar(distance).add(this.mainControls.target);
        this.animateCamera(newPosition);
    }

    /**
     * Glides the main camera to a new position.
     *
     * @param targetPosition - Where the camera should end up.
     */
    private animateCamera(targetPosition: THREE.Vector3) {
        // A second click replaces the move in progress instead of fighting it.
        this.cancelCameraAnimation();

        const startPosition = this.mainCamera.position.clone();
        const duration = 500; // ms
        const startTime = Date.now();

        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // Use easing function
            const easeProgress = this.easeInOutCubic(progress);

            this.mainCamera.position.lerpVectors(startPosition, targetPosition, easeProgress);
            this.mainControls.update();

            this.cameraAnimationFrame = progress < 1 ? requestAnimationFrame(animate) : null;
        };

        animate();
    }

    /** Stops the camera move animation, if one is running. */
    public cancelCameraAnimation() {
        if (this.cameraAnimationFrame !== null) {
            cancelAnimationFrame(this.cameraAnimationFrame);
            this.cameraAnimationFrame = null;
        }
    }

    private easeInOutCubic(t: number): number {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    /**
     * Points the cube's camera along the same direction as the main camera.
     */
    public update() {
        // Keep the cube axis-aligned with the world and orbit the mini camera instead,
        // so the cube is always seen from exactly the same direction as the main camera.
        const offset = this.mainCamera.position.clone().sub(this.mainControls.target);

        if (offset.lengthSq() < 1e-8) return;

        this.camera.position.copy(offset.normalize().multiplyScalar(5));
        this.camera.up.copy(this.mainCamera.up);
        this.camera.lookAt(0, 0, 0);
    }

    /**
     * Draws the cube. Call once per frame from the main render loop.
     */
    public render() {
        this.update();
        this.renderer.render(this.scene, this.camera);
    }

    /**
     * Stops any running animation, removes the cube from the page and frees its resources.
     */
    public dispose() {
        this.cancelCameraAnimation();
        this.canvas.removeEventListener('click', this.handleClick);
        this.canvas.removeEventListener('mousemove', this.handleMouseMove);
        this.canvas.remove();

        this.scene.traverse(child => {
            const mesh = child as Partial<THREE.Mesh>;
            mesh.geometry?.dispose();
            const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
            materials.forEach(material => {
                (material as THREE.MeshLambertMaterial).map?.dispose();
                material.dispose();
            });
        });
        this.renderer.dispose();
    }
}
