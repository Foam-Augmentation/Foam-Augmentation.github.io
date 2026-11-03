// src/visualizer/gui/ViewCube.ts
import * as THREE from 'three';

export interface ViewCubeOptions {
    size?: number;
    position?: { top: number; right: number };
    opacity?: number;
}

export class ViewCube {
    private scene!: THREE.Scene;
    private camera!: THREE.OrthographicCamera;
    private renderer!: THREE.WebGLRenderer;
    private cube!: THREE.Mesh;
    private container!: HTMLElement;
    private canvas!: HTMLCanvasElement;
    private raycaster!: THREE.Raycaster;
    private mouse!: THREE.Vector2;
    private mainCamera: THREE.PerspectiveCamera;
    private mainControls: any;
    private size: number;

    // Face materials
    private faces = [
        { name: 'Right', color: 0xff6b6b, position: new THREE.Vector3(2, 0, 0) },
        { name: 'Left', color: 0x4ecdc4, position: new THREE.Vector3(-2, 0, 0) },
        { name: 'Top', color: 0x45b7d1, position: new THREE.Vector3(0, 0, 2) },
        { name: 'Bottom', color: 0x96ceb4, position: new THREE.Vector3(0, 0, -2) },
        { name: 'Front', color: 0xfeca57, position: new THREE.Vector3(0, -2, 0) },
        { name: 'Back', color: 0xff9ff3, position: new THREE.Vector3(0, 2, 0) }
    ];

    constructor(
        mainCamera: THREE.PerspectiveCamera,
        mainControls: any,
        options: ViewCubeOptions = {}
    ) {
        this.mainCamera = mainCamera;
        this.mainControls = mainControls;
        this.size = options.size || 120;

        // Initialize properties
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        this.setupCanvas(options);
        this.setupScene();
        this.setupCube();
        this.setupEventListeners();
        this.animate();
    }

    private setupCanvas(options: ViewCubeOptions) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.size;
        this.canvas.height = this.size;
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = `${options.position?.top || 20}px`;
        this.canvas.style.right = `${options.position?.right || 20}px`;
        this.canvas.style.border = '2px solid #333';
        this.canvas.style.borderRadius = '8px';
        this.canvas.style.cursor = 'pointer';
        this.canvas.style.zIndex = '1000';
        this.canvas.style.backgroundColor = 'rgba(0, 0, 0, 0.1)';
        this.canvas.style.backdropFilter = 'blur(10px)';

        document.body.appendChild(this.canvas);

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
    }

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
        this.camera.rotation.x = Math.PI / 2;
        this.camera.lookAt(0, 0, 0);
        // this.camera.rotation.x = Math.PI / 2;

        // Setup renderer
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            alpha: true,
            antialias: true
        });
        this.renderer.setSize(this.size, this.size);
        this.renderer.setClearColor(0x000000, 0);

        // Add lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(5, 5, 5);
        this.scene.add(directionalLight);
    }

    private setupCube() {
        const geometry = new THREE.BoxGeometry(1, 1, 1);

        // Create materials for each face with different colors (NEdd to add fonts to render using fonts)
        const materials = [
            new THREE.MeshLambertMaterial({ color: this.faces[0].color }), // Right
            new THREE.MeshLambertMaterial({ color: this.faces[1].color }), // Left  
            new THREE.MeshLambertMaterial({ color: this.faces[2].color }), // Top
            new THREE.MeshLambertMaterial({ color: this.faces[3].color }), // Bottom
            new THREE.MeshLambertMaterial({ color: this.faces[4].color }), // Front
            new THREE.MeshLambertMaterial({ color: this.faces[5].color })  // Back
        ];

        this.cube = new THREE.Mesh(geometry, materials);
        this.scene.add(this.cube);


        this.addFaceLabels();
    }

    private addFaceLabels() {
        // const loader = new THREE.FontLoader();
        // need to load the font (if wanted)
        const sphereGeometry = new THREE.SphereGeometry(0.05, 8, 8);
        const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });

        // corner indicators
        const corners = [
            [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, -0.5]
        ];

        corners.forEach(([x, y, z]) => {
            const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
            sphere.position.set(x, y, z);
            this.scene.add(sphere);
        });
    }

    private setupEventListeners() {
        this.canvas.addEventListener('click', (event) => {
            this.handleClick(event);
        });

        this.canvas.addEventListener('mousemove', (event) => {
            this.handleMouseMove(event);
        });
    }

    private handleClick(event: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / this.size) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / this.size) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObject(this.cube);

        if (intersects.length > 0) {
            const face = intersects[0].face;
            if (face) {
                this.setMainCameraView(face.materialIndex);
            }
        }
    }

    private handleMouseMove(event: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / this.size) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / this.size) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObject(this.cube);

        //highlight hovered face
        if (intersects.length > 0) {
            this.canvas.style.filter = 'brightness(1.2)';
        } else {
            this.canvas.style.filter = 'brightness(1)';
        }
    }

    private setMainCameraView(faceIndex: number) {
        const face = this.faces[faceIndex];
        if (!face) return;

        // Calculate camera position based on face
        const distance = Math.max(
            this.mainControls.object.position.distanceTo(this.mainControls.target),
            50
        );

        let newPosition: THREE.Vector3;

        switch (faceIndex) {
            case 0: // Right
                newPosition = new THREE.Vector3(distance, 0, 0);
                break;
            case 1: // Left
                newPosition = new THREE.Vector3(-distance, 0, 0);
                break;
            case 2: // Top
                newPosition = new THREE.Vector3(0, 0, distance);
                break;
            case 3: // Bottom
                newPosition = new THREE.Vector3(0, 0, -distance);
                break;
            case 4: // Front
                newPosition = new THREE.Vector3(0, -distance, 0);
                break;
            case 5: // Back
                newPosition = new THREE.Vector3(0, distance, 0);
                break;
            default:
                return;
        }

        // Add current target position to the new position
        newPosition.add(this.mainControls.target);

        // move camera
        this.animateCamera(newPosition);
    }

    private animateCamera(targetPosition: THREE.Vector3) {
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

            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };

        animate();
    }

    private easeInOutCubic(t: number): number {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    public update() {
        // Keep the cube axis-aligned with the world and orbit the mini camera instead,
        // so the cube is always seen from exactly the same direction as the main camera.
        const target = this.mainControls?.target ?? new THREE.Vector3();
        const offset = this.mainCamera.position.clone().sub(target);

        if (offset.lengthSq() < 1e-8) return;

        this.camera.position.copy(offset.normalize().multiplyScalar(5));
        this.camera.up.copy(this.mainCamera.up);
        this.camera.lookAt(0, 0, 0);
    }

    private animate = () => {
        requestAnimationFrame(this.animate);
        this.update();
        this.renderer.render(this.scene, this.camera);
    }

    public dispose() {
        document.body.removeChild(this.canvas);
        this.renderer.dispose();
    }
}