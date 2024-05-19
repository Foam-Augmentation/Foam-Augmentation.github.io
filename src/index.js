import * as THREE from 'three';
import Stats from 'stats.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader';
import { MeshBVH, INTERSECTED, NOT_INTERSECTED, CONTAINED } from 'three-mesh-bvh';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';

class Visualizer {
    constructor(containerId, printer) {
        this.container = document.getElementById(containerId);
        this.printer = printer;

        // check if container element exists
        if (!this.container) {
            throw new Error("Container element not found");
        }

        const canvas = this.container.querySelector("canvas");

        // check if canvas element exists
        if (!canvas) {
            throw new Error("Canvas element not found");
        }

        this.renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            alpha: true,
            antialias: true
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        const bgColor = new THREE.Color(0x262626);
        this.renderer.setClearColor(bgColor, 1);
        this.container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 10000);
        // camera position
        this.camera.position.set(250, 250, 250);
        // camera direction
        this.camera.lookAt(0, 0, 0);
        // set camera rotation (by setting the up-vector to align with z-axis)
        this.camera.up.set(0, 0, 1);
        // add camera to the scene
        this.scene.add(this.camera);

        // initialize OrbitControls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true; // Enable damping effects (dynamic effects) to enhance the viewing experience
        this.controls.dampingFactor = 0.25; // damping factor

        // printer bounding box
        this.xMax = this.printer.machine_depth;
        this.yMax = this.printer.machine_depth;
        this.zMax = this.printer.machine_height;

        // translation of the stl mesh
        this.targetX = 0;
        this.targetY = 0;
        this.targetZ = 0;

        // toolpath sample points
        this.toolpathSamplePoints = []; // store the sample points, unordered
        // corner points for the toolpath sample points
        this.cornerPtXMaxYMin = null;
        this.cornerPtXMaxYMax = null;
        this.cornerPtXMinYMin = null;
        this.cornerPtXMinYMax = null;
        this.cornerPtYMaxXMin = null;
        this.cornerPtYMaxXMax = null;
        this.cornerPtYMinXMin = null;
        this.cornerPtYMinXMax = null;

        this.cornerPointMeshes = {
            cornerPtXMaxYMin: null,
            cornerPtXMaxYMax: null,
            cornerPtXMinYMin: null,
            cornerPtXMinYMax: null,
            cornerPtYMaxXMin: null,
            cornerPtYMaxXMax: null,
            cornerPtYMinXMin: null,
            cornerPtYMinXMax: null
        };

        this.toolpathZigzagPath = []; // store the zigzag toolpath, ordered
        this.toolpathVisualize = null; // store the toolpath THREE visualization

        // parameters for the selection tool
        this.selectParams = {
            toolMode: 'lasso',
            selectionMode: 'centroid-visible',
            liveUpdate: false,
            selectModel: false,
            selectWireframe: false,

            objectWireframe: false,
            objectBoundingBox: false, // bounding box for the stl file
            selectBoundingBox: false,

            // printer parameters
            bedTemp: 100,
            nozzleLeftTemp: 240,
            nozzleRightTemp: 260,

            // toolpath parameters
            zOffset: 12,
            deltaZ: 5,
            foamLayers: 3,
            // useBoundsTree: true,

            // displayHelper: false,
            // helperDepth: 10,
            // rotate: true,
        };
        this.selectionPoints = [];
        this.dragging = false;
        this.selectionShapeNeedsUpdate = false;
        this.selectionNeedsUpdate = false;
        // selection shape
        this.selectionShape = new THREE.Line();
        this.selectionShape.material.color.set(0xff9800).convertSRGBToLinear();
        this.selectionShape.renderOrder = 1;
        this.selectionShape.position.z = - .2;
        this.selectionShape.depthTest = false;
        this.selectionShape.scale.setScalar(1);
        this.camera.add(this.selectionShape); // the selection shape is a child of the camera

        // group for selected objects
        this.group = new THREE.Group();

        // mesh
        this.mesh = new THREE.Mesh();
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;
        this.group.add(this.mesh);

        this.constrainBounding = []; // the bounding box of the bottom of the mesh (use as constraint)

        this.selectedMesh = new THREE.Mesh();

        // highlight mesh
        this.highlightMesh = new THREE.Mesh();
        this.highlightMesh.geometry = this.mesh.geometry.clone();
        this.highlightMesh.geometry.drawRange.count = 0;
        this.highlightMesh.material = new THREE.MeshBasicMaterial({
            opacity: 0.3,
            transparent: true,
            depthWrite: false,
            wireframe: false,
        });
        this.highlightMesh.material.color.set(0xff9800).convertSRGBToLinear();
        this.highlightMesh.renderOrder = 1;
        this.group.add(this.highlightMesh);

        // hightlighted wireframe mesh
        this.highlightWireframeMesh = new THREE.Mesh();
        this.highlightWireframeMesh.geometry = this.highlightMesh.geometry;
        this.highlightWireframeMesh.material = new THREE.MeshBasicMaterial({
            opacity: 0.3,
            transparent: true,
            wireframe: true,
            depthWrite: false,
        });
        this.highlightWireframeMesh.material.color.copy(this.highlightMesh.material.color);
        this.highlightWireframeMesh.renderOrder = 2;
        this.group.add(this.highlightWireframeMesh);

        // sample step (the grid size for the grid sampling process), aka delta_d in the notebook
        this.sampleStep = 4;

        // stats
        this.stats = new Stats();
        this.container.appendChild(this.stats.dom);

        // GUI
        this.gui = new GUI();
        const selectionFolder = this.gui.addFolder('selection');
        selectionFolder.add(this.selectParams, 'toolMode', ['lasso', 'box']);
        selectionFolder.add(this.selectParams, 'selectionMode', ['centroid-visible', 'intersection', 'centroid']);
        selectionFolder.add(this.selectParams, 'selectModel');
        selectionFolder.add(this.selectParams, 'liveUpdate');
        selectionFolder.add(this.selectParams, 'selectWireframe');
        // selectionFolder.add(this.selectParams, 'useBoundsTree');
        selectionFolder.open();

        const displayFolder = this.gui.addFolder('display');
        displayFolder.add(this.selectParams, 'objectWireframe');
        displayFolder.add(this.selectParams, 'objectBoundingBox')
            .onChange(this.#toggleObjectBoundingBoxVisibility.bind(this));
        displayFolder.add(this.selectParams, 'selectBoundingBox')
            .onChange(v => {
                if (v) {
                    this.scene.add(this.selectedMeshBoundingBoxHelper);
                } else {
                    this.scene.remove(this.selectedMeshBoundingBoxHelper);
                }
            });
        displayFolder.open();

        const printerFolder = this.gui.addFolder('printer settings');
        printerFolder.add(this.selectParams, 'bedTemp', 0, 110, 1)
            .onChange(v => {
                this.printer.material_bed_temperature = v;
            });
        printerFolder.add(this.selectParams, 'nozzleLeftTemp', 0, 260, 1)
            .onChange(v => {
                this.printer.print_temp_left_extruder = v;
            });
        printerFolder.add(this.selectParams, 'nozzleRightTemp', 0, 260, 1)
            .onChange(v => {
                this.printer.print_temp_right_extruder = v;
            });


        const toolpathFolder = this.gui.addFolder('foam toolpath');
        toolpathFolder.add(this.selectParams, 'zOffset', 0, 50, 1)
            .onChange(v => {
                console.log(v);
                // this.#sampleSelectedMesh();
                this.createZigzagPath({deltaZ: this.selectParams.deltaZ, layerNum: this.selectParams.foamLayers, zOffset: v});
                this.#visualizeToolpath(this.toolpathZigzagPath);
            });
        toolpathFolder.add(this.selectParams, 'deltaZ', 1, 20, 1)
            .onChange(v => {
                console.log(v);
                // this.#sampleSelectedMesh();
                this.createZigzagPath({ deltaZ: v, layerNum: this.selectParams.foamLayers, zOffset: this.selectParams.zOffset});
                this.#visualizeToolpath(this.toolpathZigzagPath);
            });
        toolpathFolder.add(this.selectParams, 'foamLayers', 1, 20, 1)
            .onChange(v => {
                console.log(v);
                // this.#sampleSelectedMesh();
                this.createZigzagPath({ deltaZ: this.selectParams.deltaZ, layerNum: v, zOffset: this.selectParams.zOffset});
                this.#visualizeToolpath(this.toolpathZigzagPath);
            });


        this.gui.open();

        this.#setupDragAndDrop();

        this.#addLights();
        this.#drawPrintBase();

        this.#lassoSelect();

        // this.animate();
        this.render();
    }

    // add lights
    #addLights() {
        const light = new THREE.DirectionalLight(0xffffff, 1);
        light.castShadow = true;
        light.shadow.mapSize.set(2048, 2048);
        light.position.set(10, 10, 10);
        this.scene.add(light);
        this.scene.add(new THREE.AmbientLight(0xffffff, 1));
    }

    // draw printer bounding box
    #drawPrintBase() {
        // printer bounding box
        const points = [
            new THREE.Vector3(0, 0, 0), // 0
            new THREE.Vector3(this.xMax, 0, 0), // 1
            new THREE.Vector3(this.xMax, this.yMax, 0), // 2
            new THREE.Vector3(0, this.yMax, 0), // 3
            new THREE.Vector3(0, 0, this.zMax), // 4
            new THREE.Vector3(this.xMax, 0, this.zMax), // 5
            new THREE.Vector3(this.xMax, this.yMax, this.zMax), // 6
            new THREE.Vector3(0, this.yMax, this.zMax) // 7
        ];

        const geometry = new THREE.BufferGeometry();

        // add bounding box coordinates to geometry
        const vertices = new Float32Array([
            ...points[0].toArray(),
            ...points[1].toArray(), // bottom
            ...points[1].toArray(),
            ...points[2].toArray(),
            ...points[2].toArray(),
            ...points[3].toArray(),
            ...points[3].toArray(),
            ...points[0].toArray(),
            ...points[4].toArray(),
            ...points[5].toArray(), // top
            ...points[5].toArray(),
            ...points[6].toArray(),
            ...points[6].toArray(),
            ...points[7].toArray(),
            ...points[7].toArray(),
            ...points[4].toArray(),
            ...points[0].toArray(),
            ...points[4].toArray(), // side
            ...points[1].toArray(),
            ...points[5].toArray(),
            ...points[2].toArray(),
            ...points[6].toArray(),
            ...points[3].toArray(),
            ...points[7].toArray()
        ]);
        geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));

        // create material
        const material = new THREE.LineDashedMaterial({
            color: 0xffffff,
            dashSize: 10, // dash length
            gapSize: 10 // padding length
        });
        // creat geometry line
        const line = new THREE.LineSegments(geometry, material);
        line.computeLineDistances();

        // add line to the scene
        this.scene.add(line);

        // add origin point
        const originGeometry = new THREE.SphereGeometry(2);
        const originMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        const originSphere = new THREE.Mesh(originGeometry, originMaterial);
        this.scene.add(originSphere);

        // Create an AxesHelper
        const axesHelper = new THREE.AxesHelper(50); // The parameter defines the length of each axis line

        // Add the AxesHelper to the scene
        this.scene.add(axesHelper);


    }

    render = () => {
        this.stats.update();
        requestAnimationFrame(this.render);
        this.mesh.material.wireframe = this.selectParams.objectWireframe;
        this.highlightMesh.material.wireframe = this.selectParams.selectWireframe;

        // Update the selection lasso lines
        if (this.selectionShapeNeedsUpdate) {
            if (this.selectParams.toolMode === 'lasso') {
                const ogLength = this.selectionPoints.length;
                this.selectionPoints.push(
                    this.selectionPoints[0],
                    this.selectionPoints[1],
                    this.selectionPoints[2]
                );
                this.selectionShape.geometry.setAttribute(
                    'position',
                    new THREE.Float32BufferAttribute(this.selectionPoints, 3, false)
                );
                this.selectionPoints.length = ogLength;
            } else {
                this.selectionShape.geometry.setAttribute(
                    'position',
                    new THREE.Float32BufferAttribute(this.selectionPoints, 3, false)
                );
            }
            this.selectionShape.frustumCulled = false;
            this.selectionShapeNeedsUpdate = false;
        }

        if (this.selectionNeedsUpdate) {
            this.selectionNeedsUpdate = false;
            if (this.selectionPoints.length > 0) {
                this.#updateSelection();
            }
        }
        const yScale = Math.tan(THREE.MathUtils.DEG2RAD * this.camera.fov / 2) * this.selectionShape.position.z;
        this.selectionShape.scale.set(- yScale * this.camera.aspect, - yScale, 1);

        this.renderer.render(this.scene, this.camera);
    }

    sliceMeshBelow(z_threshold = 0.1) {
        const geometry = this.mesh.geometry;
        const material = this.mesh.material.clone(); // Clone material if necessary to avoid side effects

        // 使用BVH进行几何裁剪
        const slicedGeometry = new THREE.BufferGeometry();

        // 只包含 z < z_threshold 的部分
        const positionAttribute = geometry.attributes.position;
        const indices = [];
        const positions = [];

        for (let i = 0; i < positionAttribute.count; i += 3) {
            const z1 = positionAttribute.getZ(i);
            const z2 = positionAttribute.getZ(i + 1);
            const z3 = positionAttribute.getZ(i + 2);

            // Check if all vertices of the face are below the threshold
            if (z1 < z_threshold && z2 < z_threshold && z3 < z_threshold) {
                indices.push(positions.length / 3, positions.length / 3 + 1, positions.length / 3 + 2);
                positions.push(
                    positionAttribute.getX(i), positionAttribute.getY(i), positionAttribute.getZ(i),
                    positionAttribute.getX(i + 1), positionAttribute.getY(i + 1), positionAttribute.getZ(i + 1),
                    positionAttribute.getX(i + 2), positionAttribute.getY(i + 2), positionAttribute.getZ(i + 2)
                );
            }
        }

        slicedGeometry.setIndex(indices);
        slicedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

        // Generate the mesh
        const slicedMesh = new THREE.Mesh(slicedGeometry, material);

        // translate the sliced mesh
        slicedMesh.position.set(this.targetX, this.targetY, this.targetZ);

        // Calculate bounding box and visualize it
        const bbox = new THREE.Box3().setFromObject(slicedMesh);
        const bboxHelper = new THREE.Box3Helper(bbox, 0xff0000); // Red bounding box
        this.scene.add(bboxHelper);

        // store the four corner points of the bounding box to this.constrainBounding
        this.constrainBounding = [
            new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.min.z),
            new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.min.z),
            new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.min.z),
            new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.min.z)
        ];

        return slicedMesh;
    }



    // update selection
    #updateSelection() {
        const invWorldMatrix = new THREE.Matrix4();
        const camLocalPosition = new THREE.Vector3();
        const tempRay = new THREE.Ray();
        const centroid = new THREE.Vector3();
        const screenCentroid = new THREE.Vector3();
        const faceNormal = new THREE.Vector3();
        const toScreenSpaceMatrix = new THREE.Matrix4();
        const boxPoints = new Array(8).fill().map(() => new THREE.Vector3());
        const boxLines = new Array(12).fill().map(() => new THREE.Line3());
        const lassoSegments = [];
        const perBoundsSegments = [];

        toScreenSpaceMatrix
            .copy(this.mesh.matrixWorld)
            .premultiply(this.camera.matrixWorldInverse)
            .premultiply(this.camera.projectionMatrix);

        // create scratch points and lines to use for selection
        while (lassoSegments.length < this.selectionPoints.length) {
            lassoSegments.push(new THREE.Line3());
        }

        lassoSegments.length = this.selectionPoints.length;

        for (let s = 0, l = this.selectionPoints.length; s < l; s += 3) {
            const line = lassoSegments[s];
            const sNext = (s + 3) % l;
            line.start.x = this.selectionPoints[s];
            line.start.y = this.selectionPoints[s + 1];

            line.end.x = this.selectionPoints[sNext];
            line.end.y = this.selectionPoints[sNext + 1];
        }

        invWorldMatrix.copy(this.mesh.matrixWorld).invert();
        camLocalPosition.set(0, 0, 0).applyMatrix4(this.camera.matrixWorld).applyMatrix4(invWorldMatrix);

        // const startTime = window.performance.now();
        const indices = [];
        this.mesh.geometry.boundsTree.shapecast({
            intersectsBounds: (box, isLeaf, score, depth) => {

                // check if bounds intersect or contain the lasso region
                if (!this.selectParams.useBoundsTree) {
                    return INTERSECTED;
                }

                // Get the bounding box points
                const { min, max } = box;
                let index = 0;

                let minY = Infinity;
                let maxY = - Infinity;
                let minX = Infinity;
                for (let x = 0; x <= 1; x++) {
                    for (let y = 0; y <= 1; y++) {
                        for (let z = 0; z <= 1; z++) {
                            const v = boxPoints[index];
                            v.x = x === 0 ? min.x : max.x;
                            v.y = y === 0 ? min.y : max.y;
                            v.z = z === 0 ? min.z : max.z;
                            v.w = 1;
                            v.applyMatrix4(toScreenSpaceMatrix);
                            index++;

                            if (v.y < minY) minY = v.y;
                            if (v.y > maxY) maxY = v.y;
                            if (v.x < minX) minX = v.x;
                        }
                    }
                }

                // Find all the relevant segments here and cache them in the above array for
                // subsequent child checks to use.
                const parentSegments = perBoundsSegments[depth - 1] || lassoSegments;
                const segmentsToCheck = perBoundsSegments[depth] || [];
                segmentsToCheck.length = 0;
                perBoundsSegments[depth] = segmentsToCheck;
                for (let i = 0, l = parentSegments.length; i < l; i++) {

                    const line = parentSegments[i];
                    const sx = line.start.x;
                    const sy = line.start.y;
                    const ex = line.end.x;
                    const ey = line.end.y;
                    if (sx < minX && ex < minX) continue;

                    const startAbove = sy > maxY;
                    const endAbove = ey > maxY;
                    if (startAbove && endAbove) continue;

                    const startBelow = sy < minY;
                    const endBelow = ey < minY;
                    if (startBelow && endBelow) continue;

                    segmentsToCheck.push(line);

                }

                if (segmentsToCheck.length === 0) {
                    return NOT_INTERSECTED;
                }

                // Get the screen space hull lines
                const hull = this.#getConvexHull(boxPoints);
                const lines = hull.map((p, i) => {
                    const nextP = hull[(i + 1) % hull.length];
                    const line = boxLines[i];
                    line.start.copy(p);
                    line.end.copy(nextP);
                    return line;

                });

                // If a lasso point is inside the hull then it's intersected and cannot be contained
                if (this.#pointRayCrossesSegments(segmentsToCheck[0].start, lines) % 2 === 1) {
                    return INTERSECTED;
                }

                // check if the screen space hull is in the lasso
                let crossings = 0;
                for (let i = 0, l = hull.length; i < l; i++) {

                    const v = hull[i];
                    const pCrossings = this.#pointRayCrossesSegments(v, segmentsToCheck);

                    if (i === 0) {
                        crossings = pCrossings;
                    }

                    // if two points on the hull have different amounts of crossings then
                    // it can only be intersected
                    if (crossings !== pCrossings) {
                        return INTERSECTED;
                    }

                }

                // check if there are any intersections
                for (let i = 0, l = lines.length; i < l; i++) {

                    const boxLine = lines[i];
                    for (let s = 0, ls = segmentsToCheck.length; s < ls; s++) {
                        if (this.#lineCrossesLine(boxLine, segmentsToCheck[s])) {
                            return INTERSECTED;
                        }
                    }
                }

                return crossings % 2 === 0 ? NOT_INTERSECTED : CONTAINED;

            },

            intersectsTriangle: (tri, index, contained, depth) => {
                const i3 = index * 3;
                const a = i3 + 0;
                const b = i3 + 1;
                const c = i3 + 2;

                // check all the segments if using no bounds tree
                const segmentsToCheck = this.selectParams.useBoundsTree ? perBoundsSegments[depth] : lassoSegments;
                if (this.selectParams.selectionMode === 'centroid' || this.selectParams.selectionMode === 'centroid-visible') {

                    // get the center of the triangle
                    centroid.copy(tri.a).add(tri.b).add(tri.c).multiplyScalar(1 / 3);
                    screenCentroid.copy(centroid).applyMatrix4(toScreenSpaceMatrix);

                    // counting the crossings
                    if (
                        contained ||
                        this.#pointRayCrossesSegments(screenCentroid, segmentsToCheck) % 2 === 1
                    ) {

                        // if we're only selecting visible faces then perform a ray check to ensure the centroid
                        // is visible.
                        if (this.selectParams.selectionMode === 'centroid-visible') {

                            tri.getNormal(faceNormal);
                            tempRay.origin.copy(centroid).addScaledVector(faceNormal, 1e-6);
                            tempRay.direction.subVectors(camLocalPosition, centroid);

                            const res = this.mesh.geometry.boundsTree.raycastFirst(tempRay, THREE.DoubleSide);
                            if (res) {
                                return false;
                            }

                        }

                        indices.push(a, b, c);
                        return this.selectParams.selectModel;

                    }

                } else if (this.selectParams.selectionMode === 'intersection') {

                    // if the parent bounds were marked as contained then we contain all the triangles within
                    if (contained) {

                        indices.push(a, b, c);
                        return this.selectParams.selectModel;

                    }

                    // get the projected vertices
                    const vertices = [
                        tri.a,
                        tri.b,
                        tri.c,
                    ];

                    // check if any of the vertices are inside the selection and if so then the triangle is selected
                    for (let j = 0; j < 3; j++) {

                        const v = vertices[j];
                        v.applyMatrix4(toScreenSpaceMatrix);

                        const crossings = this.#pointRayCrossesSegments(v, segmentsToCheck);
                        if (crossings % 2 === 1) {

                            indices.push(a, b, c);
                            return this.selectParams.selectModel;

                        }

                    }

                    // get the lines for the triangle
                    const lines = [
                        boxLines[0],
                        boxLines[1],
                        boxLines[2],
                    ];

                    lines[0].start.copy(tri.a);
                    lines[0].end.copy(tri.b);

                    lines[1].start.copy(tri.b);
                    lines[1].end.copy(tri.c);

                    lines[2].start.copy(tri.c);
                    lines[2].end.copy(tri.a);

                    // check for the case where a selection intersects a triangle but does not contain any
                    // of the vertices
                    for (let i = 0; i < 3; i++) {
                        const l = lines[i];
                        for (let s = 0, sl = segmentsToCheck.length; s < sl; s++) {
                            if (this.#lineCrossesLine(l, segmentsToCheck[s])) {
                                indices.push(a, b, c);
                                return this.selectParams.selectModel;
                            }
                        }
                    }
                }
                return false;
            }
        });

        // const traverseTime = window.performance.now() - startTime;
        // outputContainer.innerText = `${traverseTime.toFixed(3)}ms`;

        const indexAttr = this.mesh.geometry.index;
        const newIndexAttr = this.highlightMesh.geometry.index;
        if (indices.length && this.selectParams.selectModel) {
            // if we found indices and we want to select the whole model
            for (let i = 0, l = indexAttr.count; i < l; i++) {
                const i2 = indexAttr.getX(i);
                newIndexAttr.setX(i, i2);
            }
            this.highlightMesh.geometry.drawRange.count = Infinity;
            newIndexAttr.needsUpdate = true;

        } else {
            // update the highlight mesh
            for (let i = 0, l = indices.length; i < l; i++) {
                const i2 = indexAttr.getX(indices[i]);
                newIndexAttr.setX(i, i2);
            }
            this.highlightMesh.geometry.drawRange.count = indices.length;
            newIndexAttr.needsUpdate = true;
        }

        this.selectedMesh = this.#createSelectedMeshFromHighlight(this.highlightMesh); // create selected mesh
        this.selectedMesh.position.set(this.targetX, this.targetY, this.targetZ); // translate the selected mesh

        this.#updateSelectedMeshBoundingBox(); // update selected mesh bounding box

        this.#sampleSelectedMesh(); // sample selected mesh
        this.createZigzagPath(); // create zigzag toolpath based on the sample points
        this.#visualizeToolpath(this.toolpathZigzagPath); // visualize the toolpath

        // visualize the bounding box of the selected mesh
        if (this.selectParams.selectBoundingBox) {
            // visualize the bounding box of the selected mesh
            this.scene.add(this.selectedMeshBoundingBoxHelper);
        }
        else {
            // remove the bounding box of the selected mesh
            if (this.selectedMeshBoundingBoxHelper) {
                this.scene.remove(this.selectedMeshBoundingBoxHelper);
            }
        }
    }

    // return a new mesh, which is the highlight (selected) mesh
    #createSelectedMeshFromHighlight(highlightMesh) {
        // if this.highlightMesh.geometry.drawRange.count is 0, return an empty mesh
        if (highlightMesh.geometry.drawRange.count === 0) {
            return new THREE.Mesh();
        }

        const geometry = highlightMesh.geometry;
        const drawRange = geometry.drawRange;

        // 新建一个BufferGeometry对象
        const selectedGeometry = new THREE.BufferGeometry();

        // 获取顶点位置属性
        const positionAttribute = geometry.attributes.position;

        // 提取drawRange指定的顶点索引
        const indicesArray = geometry.index.array.slice(drawRange.start, drawRange.start + drawRange.count);
        const positions = [];

        // 提取这些索引对应的顶点坐标
        for (let i = 0; i < indicesArray.length; i++) {
            const vertexIndex = indicesArray[i];
            positions.push(
                positionAttribute.getX(vertexIndex),
                positionAttribute.getY(vertexIndex),
                positionAttribute.getZ(vertexIndex)
            );
        }

        // 设置新几何体的顶点位置
        selectedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

        // 创建一个新的mesh，使用相同的材料
        const selectedMeshMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true });
        this.selectedMesh = new THREE.Mesh(selectedGeometry, selectedMeshMaterial);
        return this.selectedMesh;
    }

    // setup drag and drop for STL files
    #setupDragAndDrop() {
        this.container.addEventListener('dragover', (event) => {
            event.preventDefault();
        });

        this.container.addEventListener('drop', (event) => {
            event.preventDefault();
            if (event.dataTransfer.items) {
                for (let i = 0; i < event.dataTransfer.items.length; i++) {
                    if (event.dataTransfer.items[i].kind === 'file') {
                        const file = event.dataTransfer.items[i].getAsFile();
                        this.#loadSTLFile(file);
                        break; // only load the first file
                    }
                }
            }
        });
    }

    // load STL file
    #loadSTLFile(file) {
        const reader = new FileReader();
        reader.onload = (event) => {
            const loader = new STLLoader();
            const geometry = loader.parse(event.target.result);
            const material = new THREE.MeshStandardMaterial({ color: 0xffffff, wireframe: true });
            const mesh = new THREE.Mesh(geometry, material);
            this.mesh = mesh; // store the mesh
            this.mesh.geometry.boundsTree = new MeshBVH(this.mesh.geometry);
            this.highlightMesh.geometry = mesh.geometry.clone(); // clone the geometry

            this.scene.clear(); // clear the scene
            this.group.clear(); // clear the group

            // Calculate bounding box
            const box = new THREE.Box3().setFromObject(mesh);
            const boxSize = box.getSize(new THREE.Vector3());
            const boxCenter = box.getCenter(new THREE.Vector3());

            // Calculate target position
            this.targetX = this.xMax / 2 - boxCenter.x;
            this.targetY = this.yMax / 2 - boxCenter.y;
            this.targetZ = -box.min.z; // This ensures the bottom is aligned with the z=0 plane

            // Apply the translation
            this.mesh.position.set(this.targetX, this.targetY, this.targetZ);
            this.highlightMesh.position.set(this.targetX, this.targetY, this.targetZ);

            this.group.add(this.mesh); // add the mesh to the group
            this.group.add(this.highlightMesh); // add the highlight mesh to the group
            this.scene.add(this.group); // add the new mesh to the scene
            this.scene.add(this.camera); // add the camera to the scene

            this.#addLights(); // add lights
            this.#drawPrintBase(); // draw printer bounding box
            this.sliceMeshBelow(); // calculate and visualize bottom constraint bounding box
            console.log(this.printer.generate_base_constraints(this.constrainBounding)); // generate base constraints gcode

        };
        reader.readAsArrayBuffer(file);

    }

    #toggleObjectBoundingBoxVisibility(visible) {
        if (visible) {
            if (!this.boundingBoxHelper) {
                const box = new THREE.Box3().setFromObject(this.mesh);
                this.boundingBoxHelper = new THREE.Box3Helper(box, 0xff0000);
                this.scene.add(this.boundingBoxHelper);
            }
            this.boundingBoxHelper.visible = true;
        } else {
            if (this.boundingBoxHelper) {
                this.boundingBoxHelper.visible = false;
            }
        }
    }

    // update the bounding box of the selected mesh
    #updateSelectedMeshBoundingBox() {
        // 移除先前的边界盒（如果存在）
        if (this.selectedMeshBoundingBoxHelper) {
            this.scene.remove(this.selectedMeshBoundingBoxHelper);
            this.selectedMeshBoundingBoxHelper.geometry.dispose();
            this.selectedMeshBoundingBoxHelper.material.dispose();
        }

        // 创建新的边界盒
        const box = new THREE.Box3().setFromObject(this.selectedMesh);
        this.selectedMeshBoundingBoxHelper = new THREE.Box3Helper(box, 0xff0000);
    }

    // sample the selected mesh (simple grid sampling method, scanning X&Y)
    #sampleSelectedMesh() {
        const bbox = this.selectedMeshBoundingBoxHelper.box;
        const gridSize = this.sampleStep;
        const vertices = [];
        this.toolpathSamplePoints = []; // clear the toolpath sample points

        const pointsMaterial = new THREE.PointsMaterial({
            size: 4,
            color: 0xff0000 // red points
        });
        const pointsGeometry = new THREE.BufferGeometry();

        // grid sample the selected mesh
        for (let x = bbox.min.x; x <= bbox.max.x; x += gridSize) {
            for (let y = bbox.min.y; y <= bbox.max.y; y += gridSize) {
                // create a ray from the top of the bounding box
                const rayOrigin = new THREE.Vector3(x, y, bbox.max.z + 10);
                const rayDirection = new THREE.Vector3(0, 0, -1);
                const raycaster = new THREE.Raycaster(rayOrigin, rayDirection);

                // check if the ray intersects the selected mesh
                const intersects = raycaster.intersectObject(this.selectedMesh);

                if (intersects.length > 0) {
                    // get the first intersection point
                    const point = intersects[0].point;
                    this.toolpathSamplePoints.push(point);
                    vertices.push(point.x, point.y, point.z); // add the point to the vertices
                }
            }
        }

        // set the vertices to the geometry
        pointsGeometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(vertices, 3)
        );

        // create a points mesh
        const pointsMesh = new THREE.Points(pointsGeometry, pointsMaterial);
        this.scene.add(pointsMesh);

        // console.log(this.toolpathSamplePoints);
        this.#findCornerPoints(); // find corner points of the toolpath sample points

        // remove the previous points mesh
        if (this.pointsMesh) {
            this.scene.remove(this.pointsMesh);
            this.pointsMesh.geometry.dispose();
            this.pointsMesh.material.dispose();
        }
        this.pointsMesh = pointsMesh; // store the points mesh
    }

    // find corner points of the toolpath sample points
    // we are interested in: The coordinates of the points of yMin, yMax in the xMax premise, the coordinates of the points of yMin, yMax in the xMin premise; the coordinates of the points of xMin, xMax in the yMax premise, the coordinates of the points of xMin, xMax in the yMin premise.
    // the xMin and xMax premise is used for the x-direction scan, and the yMin and yMax premise is used for the y-direction scan
    #findCornerPoints() {
        const xMax = Math.max(...this.toolpathSamplePoints.map(p => p.x));
        const xMin = Math.min(...this.toolpathSamplePoints.map(p => p.x));
        const yMax = Math.max(...this.toolpathSamplePoints.map(p => p.y));
        const yMin = Math.min(...this.toolpathSamplePoints.map(p => p.y));

        const xMaxPoints = this.toolpathSamplePoints.filter(p => p.x === xMax);
        const xMinPoints = this.toolpathSamplePoints.filter(p => p.x === xMin);
        const yMaxPoints = this.toolpathSamplePoints.filter(p => p.y === yMax);
        const yMinPoints = this.toolpathSamplePoints.filter(p => p.y === yMin);

        this.cornerPtXMaxYMin = xMaxPoints.reduce((min, p) => p.y < min.y ? p : min, xMaxPoints[0]);
        this.cornerPtXMaxYMax = xMaxPoints.reduce((max, p) => p.y > max.y ? p : max, xMaxPoints[0]);
        this.cornerPtXMinYMin = xMinPoints.reduce((min, p) => p.y < min.y ? p : min, xMinPoints[0]);
        this.cornerPtXMinYMax = xMinPoints.reduce((max, p) => p.y > max.y ? p : max, xMinPoints[0]);
        this.cornerPtYMaxXMin = yMaxPoints.reduce((min, p) => p.x < min.x ? p : min, yMaxPoints[0]);
        this.cornerPtYMaxXMax = yMaxPoints.reduce((max, p) => p.x > max.x ? p : max, yMaxPoints[0]);
        this.cornerPtYMinXMin = yMinPoints.reduce((min, p) => p.x < min.x ? p : min, yMinPoints[0]);
        this.cornerPtYMinXMax = yMinPoints.reduce((max, p) => p.x > max.x ? p : max, yMinPoints[0]);

        // Visualize the corner points
        this.#visualizeCornerPoint('cornerPtXMaxYMin', this.cornerPtXMaxYMin);
        this.#visualizeCornerPoint('cornerPtXMaxYMax', this.cornerPtXMaxYMax);
        this.#visualizeCornerPoint('cornerPtXMinYMin', this.cornerPtXMinYMin);
        this.#visualizeCornerPoint('cornerPtXMinYMax', this.cornerPtXMinYMax);
        this.#visualizeCornerPoint('cornerPtYMaxXMin', this.cornerPtYMaxXMin);
        this.#visualizeCornerPoint('cornerPtYMaxXMax', this.cornerPtYMaxXMax);
        this.#visualizeCornerPoint('cornerPtYMinXMin', this.cornerPtYMinXMin);
        this.#visualizeCornerPoint('cornerPtYMinXMax', this.cornerPtYMinXMax);
    }

    // visualize the corner point
    #visualizeCornerPoint(cornerPointKey, cornerPoint) {
        // First, remove the existing mesh if it exists
        if (this.cornerPointMeshes[cornerPointKey]) {
            this.scene.remove(this.cornerPointMeshes[cornerPointKey]);
            this.cornerPointMeshes[cornerPointKey].geometry.dispose();
            this.cornerPointMeshes[cornerPointKey].material.dispose();
            this.cornerPointMeshes[cornerPointKey] = null;
        }

        if (!cornerPoint) {
            console.error('Invalid point data:', cornerPoint);
            return;
        }

        const sphereGeometry = new THREE.SphereGeometry(1, 16, 16);
        const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0xCC00FF });
        const sphereMesh = new THREE.Mesh(sphereGeometry, sphereMaterial);
        sphereMesh.position.set(cornerPoint.x, cornerPoint.y, cornerPoint.z);
        this.scene.add(sphereMesh);
        this.cornerPointMeshes[cornerPointKey] = sphereMesh;  // Store the new mesh
        console.log('Point visualized at:', cornerPoint);
    }

    // optimize the zigzag path 🛑🛑 still potential bugs here!
    // given the current point (the currentPt), find the nearest corner point on the next layer
    // so the free travel distance between layers is minimized
    #findNearestCornerPoint(currentPt, scanDirection, currentLayer, zOffset, deltaZ) {
        let cornerPoints = [];
        let adjustedPoints = [];

        if (scanDirection === "y") {
            cornerPoints = [
                this.cornerPtYMaxXMin,
                this.cornerPtYMaxXMax,
                this.cornerPtYMinXMin,
                this.cornerPtYMinXMax
            ];
        } else if (scanDirection === "x") {
            cornerPoints = [
                this.cornerPtXMaxYMin,
                this.cornerPtXMaxYMax,
                this.cornerPtXMinYMax,
                this.cornerPtXMinYMin
            ];
        }

        // 调整角点的 z 值
        adjustedPoints = cornerPoints.map(point => {
            let newZ = point.z + zOffset + (currentLayer - 1) * deltaZ;
            return new THREE.Vector3(point.x, point.y, newZ);
        });

        // 查找距离 currentPt 最近的点
        let closestPoint = adjustedPoints[0];
        let minDistance = currentPt.distanceTo(adjustedPoints[0]);

        adjustedPoints.forEach(point => {
            const distance = currentPt.distanceTo(point);
            if (distance < minDistance) {
                minDistance = distance;
                closestPoint = point;
            }
        });

        // visualize the closest point
        // const closestPointMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        // const closestPointGeometry = new THREE.SphereGeometry(1);
        // const closestPointMesh = new THREE.Mesh(closestPointGeometry, closestPointMaterial);
        // closestPointMesh.position.set(closestPoint.x, closestPoint.y, closestPoint.z);
        // this.scene.add(closestPointMesh);

        // 检查并返回额外的信息
        let positionFlag;
        let valueAdjustment;

        if (scanDirection === "y") {
            const maxY = Math.max(...adjustedPoints.map(p => p.y));
            const minY = Math.min(...adjustedPoints.map(p => p.y));
            positionFlag = closestPoint.y === maxY ? "max" : "min";
            valueAdjustment = closestPoint.x === this.cornerPtYMaxXMin.x || closestPoint.x === this.cornerPtYMinXMin.x ? 1 : -1;
            return [closestPoint.y, valueAdjustment, positionFlag];
        } else if (scanDirection === "x") {
            const maxX = Math.max(...adjustedPoints.map(p => p.x));
            const minX = Math.min(...adjustedPoints.map(p => p.x));
            positionFlag = closestPoint.x === maxX ? "max" : "min";
            valueAdjustment = closestPoint.y === this.cornerPtXMaxYMin.y || closestPoint.y === this.cornerPtXMinYMin.y ? 1 : -1;
            return [closestPoint.x, valueAdjustment, positionFlag];
        }
    }


    // create zigzag toolpath from the sample points
    // zOffset: the offset from the sample points (the offset distance for the first layer)
    // deltaZ: the distance between layers
    createZigzagPath({ zOffset = 12, deltaZ = 5, layerNum = 3 } = {}) {

        // handle empty sample points
        if (this.toolpathSamplePoints.length == 0) {
            // console.log("No sample points found.");
            this.toolpathZigzagPath = [];
            return [];
        }
        let currentLayer = 1;
        this.toolpathZigzagPath = []; // clear the toolpath zigzag path

        while (currentLayer <= layerNum) {
            let scanDirection = currentLayer % 2 === 1 ? 'x' : 'y'; // 奇数层按 x 扫描，偶数层按 y 扫描
            let tempPoints = [];
            let yDirection = 1;
            let xDirection = 1;
            let currentX, currentY;
            let positionFlag;
            this.toolpathZigzagPath.push([]); // add a new layer

            if (scanDirection === 'x') {
                // x direction scan
                if (currentLayer === 1) {
                    this.toolpathSamplePoints.sort((a, b) => a.x - b.x || a.y - b.y);
                    currentX = this.toolpathSamplePoints[0].x;
                    yDirection = 1;
                }
                else {
                    [currentX, yDirection, positionFlag] = this.#findNearestCornerPoint(this.toolpathZigzagPath[this.toolpathZigzagPath.length - 2][this.toolpathZigzagPath[this.toolpathZigzagPath.length - 2].length - 1], scanDirection, currentLayer, zOffset, deltaZ);
                    // cloest point has max x value, so descending sort
                    if (positionFlag === "max") {
                        this.toolpathSamplePoints.sort((a, b) => b.x - a.x || a.y - b.y);
                    }
                    else {
                        this.toolpathSamplePoints.sort((a, b) => a.x - b.x || a.y - b.y);
                    }
                    console.log(currentX, yDirection);
                }

                this.toolpathSamplePoints.forEach(point => {
                    if (point.x === currentX) {
                        // 在相同 x 值下根据 y 方向排序
                        tempPoints.push(new THREE.Vector3(point.x, point.y, point.z + zOffset + (currentLayer - 1) * deltaZ));
                    } else {
                        // 当 x 改变时，根据 y 方向排序并更新路径
                        tempPoints.sort((a, b) => yDirection > 0 ? a.y - b.y : b.y - a.y);
                        this.toolpathZigzagPath[this.toolpathZigzagPath.length - 1].push(...tempPoints);
                        // 为下一个 x 值准备 tempPoints
                        currentX = point.x;
                        tempPoints = [new THREE.Vector3(point.x, point.y, point.z + zOffset + (currentLayer - 1) * deltaZ)];
                        yDirection = -yDirection;
                    }
                });
            } else {
                // y direction scan
                [currentY, xDirection, positionFlag] = this.#findNearestCornerPoint(this.toolpathZigzagPath[this.toolpathZigzagPath.length - 2][this.toolpathZigzagPath[this.toolpathZigzagPath.length - 2].length - 1], scanDirection, currentLayer, zOffset, deltaZ);
                // cloest point has max y value, so descending sort
                if (positionFlag === "max") {
                    this.toolpathSamplePoints.sort((a, b) => b.y - a.y || a.x - b.x);
                }
                else {
                    this.toolpathSamplePoints.sort((a, b) => a.y - b.y || a.x - b.x);
                }

                // currentY = this.toolpathSamplePoints[0].y;
                // xDirection = -1;

                this.toolpathSamplePoints.forEach(point => {
                    if (point.y === currentY) {
                        // 在相同 y 值下根据 x 方向排序
                        tempPoints.push(new THREE.Vector3(point.x, point.y, point.z + zOffset + (currentLayer - 1) * deltaZ));
                    } else {
                        // 当 y 改变时，根据 x 方向排序并更新路径
                        tempPoints.sort((a, b) => xDirection > 0 ? a.x - b.x : b.x - a.x);
                        this.toolpathZigzagPath[this.toolpathZigzagPath.length - 1].push(...tempPoints);
                        // 为下一个 y 值准备 tempPoints
                        currentY = point.y;
                        tempPoints = [new THREE.Vector3(point.x, point.y, point.z + zOffset + (currentLayer - 1) * deltaZ)];
                        xDirection = -xDirection;
                    }
                });
            }

            // 添加最后一批点到路径中
            if (tempPoints.length > 0) {
                if (scanDirection === 'x') {
                    tempPoints.sort((a, b) => yDirection > 0 ? a.y - b.y : b.y - a.y);
                } else {
                    tempPoints.sort((a, b) => xDirection > 0 ? a.x - b.x : b.x - a.x);
                }
                this.toolpathZigzagPath[this.toolpathZigzagPath.length - 1].push(...tempPoints);

            }

            // 准备下一层的扫描
            currentLayer++;
        }

        // generate the zigzag gcode
        const gcode = this.printer.generate_foam_gcode(this.toolpathZigzagPath, 1);
        console.log(gcode);
    }

    #visualizeToolpath(toolpath) {
        // 先清除旧的可视化对象
        if (this.toolpathVisualize != null && this.toolpathVisualize.length > 0)
            this.toolpathVisualize.forEach(mesh => {
                if (mesh) {
                    mesh.geometry.dispose(); // 释放几何体内存
                    mesh.material.dispose(); // 释放材料内存
                    this.scene.remove(mesh); // 从场景中移除
                }
            });
        this.toolpathVisualize = [];

        // 准备材料
        const materialInner = new THREE.LineBasicMaterial({ color: 0x0075FF }); // 内部连线，blue
        const materialInterLayer = new THREE.LineBasicMaterial({ color: 0x00ff00 }); // 层间连线，green

        toolpath.forEach((layer, index) => {
            // 处理当前层的连线
            const verticesInner = layer.map(p => [p.x, p.y, p.z]).flat();
            const geometryInner = new THREE.BufferGeometry();
            geometryInner.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verticesInner), 3));
            const lineInner = new THREE.Line(geometryInner, materialInner);
            this.scene.add(lineInner);
            this.toolpathVisualize.push(lineInner);

            // 处理层间连线
            if (index < toolpath.length - 1) {
                const lastPointCurrentLayer = layer[layer.length - 1];
                const firstPointNextLayer = toolpath[index + 1][0];

                const verticesInterLayer = [lastPointCurrentLayer, firstPointNextLayer].map(p => [p.x, p.y, p.z]).flat();
                const geometryInterLayer = new THREE.BufferGeometry();
                geometryInterLayer.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verticesInterLayer), 3));
                const lineInterLayer = new THREE.Line(geometryInterLayer, materialInterLayer);
                this.scene.add(lineInterLayer);
                this.toolpathVisualize.push(lineInterLayer);
            }
        });
    }

    // lattice selection tool
    #lassoSelect() {
        // handle building lasso shape
        let startX = - Infinity;
        let startY = - Infinity;

        let prevX = - Infinity;
        let prevY = - Infinity;

        const tempVec0 = new THREE.Vector2();
        const tempVec1 = new THREE.Vector2();
        const tempVec2 = new THREE.Vector2();

        this.renderer.domElement.addEventListener('pointerdown', e => {
            prevX = e.clientX;
            prevY = e.clientY;
            startX = (e.clientX / window.innerWidth) * 2 - 1;
            startY = - ((e.clientY / window.innerHeight) * 2 - 1);
            this.selectionPoints.length = 0;
            this.dragging = true;
        });

        this.renderer.domElement.addEventListener('pointerup', () => {
            this.controls.enabled = true; // ebable orbit controls

            this.selectionShape.visible = false;
            this.dragging = false;
            if (this.selectionPoints.length) {
                this.selectionNeedsUpdate = true;
            }
        });

        this.renderer.domElement.addEventListener('pointermove', e => {
            // console.log(e.metaKey);
            // If the left mouse button is not pressed
            if ((1 & e.buttons) === 0 || !e.metaKey) {
                return;
            }

            //disable orbit controls
            this.controls.enabled = false;

            const ex = e.clientX;
            const ey = e.clientY;

            const nx = (e.clientX / window.innerWidth) * 2 - 1;
            const ny = - ((e.clientY / window.innerHeight) * 2 - 1);

            if (this.selectParams.toolMode === 'box') {

                // set points for the corner of the box
                this.selectionPoints.length = 3 * 5;

                this.selectionPoints[0] = startX;
                this.selectionPoints[1] = startY;
                this.selectionPoints[2] = 0;

                this.selectionPoints[3] = nx;
                this.selectionPoints[4] = startY;
                this.selectionPoints[5] = 0;

                this.selectionPoints[6] = nx;
                this.selectionPoints[7] = ny;
                this.selectionPoints[8] = 0;

                this.selectionPoints[9] = startX;
                this.selectionPoints[10] = ny;
                this.selectionPoints[11] = 0;

                this.selectionPoints[12] = startX;
                this.selectionPoints[13] = startY;
                this.selectionPoints[14] = 0;

                if (ex !== prevX || ey !== prevY) {
                    this.selectionShapeNeedsUpdate = true;
                }

                prevX = ex;
                prevY = ey;
                this.selectionShape.visible = true;
                if (this.selectParams.liveUpdate) {
                    this.selectionNeedsUpdate = true;
                }

            } else {

                // If the mouse hasn't moved a lot since the last point
                if (
                    Math.abs(ex - prevX) >= 3 ||
                    Math.abs(ey - prevY) >= 3
                ) {

                    // Check if the mouse moved in roughly the same direction as the previous point
                    // and replace it if so.
                    const i = (this.selectionPoints.length / 3) - 1;
                    const i3 = i * 3;
                    let doReplace = false;
                    if (this.selectionPoints.length > 3) {

                        // prev segment direction
                        tempVec0.set(this.selectionPoints[i3 - 3], this.selectionPoints[i3 - 3 + 1]);
                        tempVec1.set(this.selectionPoints[i3], this.selectionPoints[i3 + 1]);
                        tempVec1.sub(tempVec0).normalize();

                        // this segment direction
                        tempVec0.set(this.selectionPoints[i3], this.selectionPoints[i3 + 1]);
                        tempVec2.set(nx, ny);
                        tempVec2.sub(tempVec0).normalize();

                        const dot = tempVec1.dot(tempVec2);
                        doReplace = dot > 0.99;
                    }

                    if (doReplace) {

                        this.selectionPoints[i3] = nx;
                        this.selectionPoints[i3 + 1] = ny;

                    } else {
                        this.selectionPoints.push(nx, ny, 0);
                    }
                    this.selectionShapeNeedsUpdate = true;
                    this.selectionShape.visible = true;

                    prevX = ex;
                    prevY = ey;

                    if (this.selectParams.liveUpdate) {

                        this.selectionNeedsUpdate = true;
                    }
                }
            }
        });
    }

    // -----------------------------Math functions-----------------------------
    // https://www.geeksforgeeks.org/convex-hull-set-2-graham-scan/
    #getConvexHull(points) {
        function orientation(p, q, r) {
            const val =
                (q.y - p.y) * (r.x - q.x) -
                (q.x - p.x) * (r.y - q.y);
            if (val == 0) {
                return 0; // colinear
            }
            // clockwise or counterclockwise
            return (val > 0) ? 1 : 2;
        }

        function distSq(p1, p2) {
            return (p1.x - p2.x) * (p1.x - p2.x) +
                (p1.y - p2.y) * (p1.y - p2.y);
        }

        function compare(p1, p2) {
            // Find orientation
            const o = orientation(p0, p1, p2);
            if (o == 0)
                return (distSq(p0, p2) >= distSq(p0, p1)) ? - 1 : 1;
            return (o == 2) ? - 1 : 1;
        }

        // find the lowest point in 2d
        let lowestY = Infinity;
        let lowestIndex = - 1;
        for (let i = 0, l = points.length; i < l; i++) {

            const p = points[i];
            if (p.y < lowestY) {
                lowestIndex = i;
                lowestY = p.y;
            }
        }

        // sort the points
        const p0 = points[lowestIndex];
        points[lowestIndex] = points[0];
        points[0] = p0;

        points = points.sort(compare);

        // filter the points
        let m = 1;
        const n = points.length;
        for (let i = 1; i < n; i++) {

            while (i < n - 1 && orientation(p0, points[i], points[i + 1]) == 0) {
                i++;
            }

            points[m] = points[i];
            m++;
        }

        // early out if we don't have enough points for a hull
        if (m < 3) return null;

        // generate the hull
        const hull = [points[0], points[1], points[2]];
        for (let i = 3; i < m; i++) {

            while (orientation(hull[hull.length - 2], hull[hull.length - 1], points[i]) !== 2) {
                hull.pop();
            }
            hull.push(points[i]);
        }
        return hull;
    }

    #pointRayCrossesLine(point, line, prevDirection, thisDirection) {

        const { start, end } = line;
        const px = point.x;
        const py = point.y;

        const sy = start.y;
        const ey = end.y;

        if (sy === ey) return false;

        if (py > sy && py > ey) return false; // above
        if (py < sy && py < ey) return false; // below

        const sx = start.x;
        const ex = end.x;
        if (px > sx && px > ex) return false; // right
        if (px < sx && px < ex) { // left

            if (py === sy && prevDirection !== thisDirection) {
                return false;
            }
            return true;
        }

        // check the side
        const dx = ex - sx;
        const dy = ey - sy;
        const perpx = dy;
        const perpy = - dx;

        const pdx = px - sx;
        const pdy = py - sy;

        const dot = perpx * pdx + perpy * pdy;

        if (Math.sign(dot) !== Math.sign(perpx)) {
            return true;
        }
        return false;
    }

    #pointRayCrossesSegments(point, segments) {
        let crossings = 0;
        const firstSeg = segments[segments.length - 1];
        let prevDirection = firstSeg.start.y > firstSeg.end.y;
        for (let s = 0, l = segments.length; s < l; s++) {
            const line = segments[s];
            const thisDirection = line.start.y > line.end.y;
            if (this.#pointRayCrossesLine(point, line, prevDirection, thisDirection)) {
                crossings++;
            }
            prevDirection = thisDirection;
        }
        return crossings;
    }

    // https://stackoverflow.com/questions/3838329/how-can-i-check-if-two-segments-intersect
    #lineCrossesLine(l1, l2) {
        function ccw(A, B, C) {
            return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
        }

        const A = l1.start;
        const B = l1.end;

        const C = l2.start;
        const D = l2.end;

        return ccw(A, C, D) !== ccw(B, C, D) && ccw(A, B, C) !== ccw(A, B, D);
    }
}

// printer class
// The following code is tested under the Dual Mode and Single Mode (Extruder 1).
// Printer: Sovol SV04 IDEX 3D Printer
class Printer {
    constructor() {
        this.extrudedAxmount = 0;
        this.extrusion_foam_rate = 1; // print foam: 1mm extrusion for 1mm movement
        this.extrusion_foam_interlayer_rate = 0.2; // normal print: 0.07mm extrusion for 1mm movement
        this.extrusion_norm_rate = 0.07; // normal print: 0.07mm extrusion for 1mm movement
        this.move_speed = 1000; // free move speed
        this.extrude_foam_speed = 70; // print foam extrusion speed
        this.extrude_foam_speed_interlayer = 200; // print foam (interlayer connection) extrusion speed
        this.extrude_norm_speed = 800; // normal print extrusion speed
        this.material_bed_temperature = 110; // bed temperature
        this.print_temp_left_extruder = 240; // left extruder temperature (TPU)
        this.print_temp_right_extruder = 260; // right extruder temperature (PLA)
        this.machine_depth = 302; // machine depth (x-axis and y-axis max length)
        this.machine_height = 402; // machine height (z-axis max length)
        this.end_gcode = `
;SV04 end
M107; turn off fan
G91 ;Relative positioning
G1 E-2 F2700 ;Retract a bit
G1 E-2 Z0.2 F2400 ;Retract and raise Z
G1 X0 Y240 F3000 ;Wipe out
G1 Z10 ;Raise Z more
G90 ;Absolute positionning
G1 X0 Y${this.machine_depth} ;Present print
M106 S0 ;Turn-off fan
M104 S0 ;Turn-off hotend
M140 S0 ;Turn-off bed
M84 X Y E ;Disable all steppers but Z
M82 ;absolute extrusion mode
        `
    }

    #build_start_gcode(extruderId) {
        if (extruderId == 1) { // The left extruder (TPU)
            return `
;Generated with Cura_SteamEngine 5.4.0
T0; left extruder
M82 ;absolute extrusion mode
;SV04 start
M140 S${this.material_bed_temperature}; print bed temperature, heat while continue to conduct following code
M104 S${this.print_temp_left_extruder}; nozzle temperature, heat while continue to conduct following code
M280 P0 S160;
G4 P100; pause 100ms
G28; home x, y, z
M420 S1; bed leveling
M190 S${this.material_bed_temperature}; print bed temperature, wait until reach the temp
M109 S${this.print_temp_left_extruder}; nozzle temperature, wait until reach the temp
G92 E0; reset extrusion count to 0; G92=set position, E=extrude, 0=set to zero

; test print of two segments of lines
G1 X10.1 Y20 Z0.28 F5000.0; fast move to position
G1 X10.1 Y200.0 Z0.28 F1500.0 E15; print the first segment
G1 X10.4 Y200.0 Z0.28 F5000.0; fast move to the second position
G1 X10.4 Y20 Z0.28 F1500.0 E30; print the second segment
G92 E0 ;Reset Extruder
G1 Z2.0 F3000;
G92 E0
G92 E0
G1 F2400 E-0.5

; M106 S255; start fan
M204 S500; set acceleration
M205 X16 Y16; set acceleration
    `;
        } else {
            return `
;Generated with Cura_SteamEngine 5.4.0
T1; right extruder
M82 ;absolute extrusion mode
;SV04 start
M140 S${this.material_bed_temperature}; print bed temperature, heat while continue to conduct following code
M104 S${this.print_temp_right_extruder}; nozzle temperature, heat while continue to conduct following code
M280 P0 S160;
G4 P100; pause 100ms
G28; home x, y, z
M420 S1; bed leveling
M190 S${this.material_bed_temperature}; print bed temperature, wait until reach the temp
M109 S${this.print_temp_right_extruder}; nozzle temperature, wait until reach the temp
G92 E0; reset extrusion count to 0; G92=set position, E=extrude, 0=set to zero

; test print of two segments of lines
G1 X10.1 Y20 Z0.28 F5000.0; fast move to position
G1 X10.1 Y200.0 Z0.28 F1500.0 E15; print the first segment
G1 X10.4 Y200.0 Z0.28 F5000.0; fast move to the second position
G1 X10.4 Y20 Z0.28 F1500.0 E30; print the second segment
G92 E0 ;Reset Extruder
G1 Z2.0 F3000;
G92 E0
G92 E0
G1 F2400 E-0.5

M106 S255; start fan
M204 S500; set acceleration
M205 X16 Y16; set acceleration
            `;
        }
    }

    move_to_position(target) {
        return `G0 X${target[0].toFixed(3)} Y${target[1].toFixed(
            3
        )} Z${target[2].toFixed(3)} F${move_speed}`;
    }

    #extrude_single_segment(p0, p1, extrude_rate, extrude_speed) {
        this.extrudedAmount += this.norm(p1, p0) * extrude_rate;
        return `G1 X${p1.x.toFixed(4)} Y${p1.y.toFixed(4)} Z${p1.z.toFixed(4)} E${this.extrudedAmount.toFixed(4)} F${extrude_speed}`;
    }

    // generate the base constraints based on the bottom boundary of the model
    // PLA print
    // offset: the offset distance from the original bounding box
    generate_base_constraints(constrainBounding, offset = 0.2, extruderId = 2, layerHeight = 0.2) {
        if (constrainBounding.length < 4) {
            console.error("ConstrainBounding does not have enough points to define a rectangle.");
            return [];
        }
        // Calculate expanded bounding box
        const minX = Math.min(...constrainBounding.map(p => p.x)) - offset;
        const maxX = Math.max(...constrainBounding.map(p => p.x)) + offset;
        const minY = Math.min(...constrainBounding.map(p => p.y)) - offset;
        const maxY = Math.max(...constrainBounding.map(p => p.y)) + offset;

        // Define corners of the expanded rectangle in proper order for extrusion
        const corners = [
            new THREE.Vector3(minX, minY, layerHeight), // Bottom Left
            new THREE.Vector3(minX, maxY, layerHeight), // Top Left
            new THREE.Vector3(maxX, maxY, layerHeight), // Top Right
            new THREE.Vector3(maxX, minY, layerHeight), // Bottom Right
            new THREE.Vector3(minX, minY, layerHeight)  // Back to Bottom Left to close loop
        ];

        // Generate the toolpath using #extrude_single_segment
        let body_gcode = [];
        this.extrudedAmount = 0;

        // kick-off gcode lines
        body_gcode.push(
            `G0 F2880 X${corners[0].x} Y${corners[0].y} Z${corners[0].z}; move to start point`
        );
        body_gcode.push("M205 X8 Y8; tune down acceleration");
        body_gcode.push("G1 F2400 E0; not sure the purpose of this line");
        for (let i = 0; i < corners.length - 1; i++) {
            body_gcode.push(this.#extrude_single_segment(corners[i], corners[i + 1], this.extrusion_norm_rate, this.extrude_norm_speed));
        }
        // connect the last point to the first point
        // body_gcode.push(this.#extrude_single_segment(corners[corners.length - 1], corners[0], this.extrusion_norm_rate, this.extrude_norm_speed));

        // end gcode lines
        body_gcode.push("G92 E0");
        this.extrudedAmount = 0;


        return this.#build_start_gcode(extruderId) + "\n\n" + body_gcode.join("\n") + "\n\n" + this.end_gcode;
    }


    generate_foam_gcode(toolpath, extruderId) {
        let body_gcode = [];
        let lastTarget;
        this.extrudedAmount = 0;

        for (let i = 0; i < toolpath.length; i++) {
            if (i === 0) {
                // kick-off gcode lines
                body_gcode.push(
                    `G0 F2880 X${toolpath[i][0].x} Y${toolpath[i][0].y} Z${toolpath[i][0].z}; move to start point`
                );
                body_gcode.push("M205 X8 Y8; tune down acceleration");
                body_gcode.push("G1 F2400 E0; not sure the purpose of this line");
            } else {
                // generate the connection line between layers
                // the extrusion rate is smaller, move speed faster than foam printing
                body_gcode.push(this.#extrude_single_segment(lastTarget, toolpath[i][0], this.extrusion_foam_interlayer_rate, this.extrude_foam_speed_interlayer)); // foam print
            }

            lastTarget = toolpath[i][0];

            for (let j = 1; j < toolpath[i].length; j++) {
                body_gcode.push(this.#extrude_single_segment(lastTarget, toolpath[i][j], this.extrusion_foam_rate, this.extrude_foam_speed)); // foam print
                lastTarget = toolpath[i][j];
            }
        }

        // end gcode lines
        body_gcode.push("G92 E0");
        this.extrudedAmount = 0;

        return this.#build_start_gcode(extruderId) + "\n\n" + body_gcode.join("\n") + "\n\n" + this.end_gcode;
    }

    norm(p1, p0) {
        return Math.sqrt(
            (p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2 + (p1.z - p0.z) ** 2
        );
    }
}

const myPrinter = new Printer();
const myVisualizer = new Visualizer('myCanvasContainer', myPrinter);
