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




import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader';
import { MeshBVH, INTERSECTED, NOT_INTERSECTED, CONTAINED } from 'three-mesh-bvh';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls';
import tippy from 'tippy.js';
import initGUI from './gui/initGUI';
import initRenderer from './renderer/initRenderer';

export default class Visualizer {
    constructor(containerId, printer) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            throw new Error("Container element not found");
        }
        this.printer = printer;
        // 调用 initRenderer() 初始化渲染器、场景、相机、控制器等
        const { renderer, scene, camera, orbitControls, printBaseObjects } = initRenderer(this.container, printer);
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.orbitControls = orbitControls;
        this.printBaseObjects = printBaseObjects;

        // const canvas = this.container.querySelector("canvas");

        // check if canvas element exists
        // if (!canvas) {
        //     throw new Error("Canvas element not found");
        // }

        // this.renderer = new THREE.WebGLRenderer({
        //     canvas: canvas,
        //     alpha: true,
        //     antialias: true
        // });
        // this.renderer.setSize(window.innerWidth, window.innerHeight);
        // const bgColor = new THREE.Color(0x262626);
        // this.renderer.setClearColor(bgColor, 1);
        // this.container.appendChild(this.renderer.domElement);


        // this.scene = new THREE.Scene();
        // this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 10000);
        // // camera position
        // this.camera.position.set(this.printer.machine_depth, this.printer.machine_depth / 2, this.printer.machine_height / 2);
        // // camera direction
        // this.camera.lookAt(0, 0, 0);
        // // set camera rotation (by setting the up-vector to align with z-axis)
        // this.camera.up.set(0, 0, 1);
        // // add camera to the scene
        // this.scene.add(this.camera);


        // initialize OrbitControls
        // this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
        // this.orbitControls.enableDamping = true; // Enable damping effects (dynamic effects) to enhance the viewing experience
        // this.orbitControls.dampingFactor = 0.25; // damping factor


        // transform controls for moving, rotating, and scaling objects
        this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
        this.transformControls.addEventListener('dragging-changed', (event) => {
            // 当拖动开始时，禁用 OrbitControls；拖动结束后启用
            this.orbitControls.enabled = !event.value;
        });
        // this.transformControls.setMode("rotate");
        this.scene.add(this.transformControls);
        this.#moveModels(); // enable moving models with transform controls

        // printer bounding box
        this.xMax = this.printer.machine_depth;
        this.yMax = this.printer.machine_depth;
        this.zMax = this.printer.machine_height;
        this.printBaseObjects = []; // store the printer base objects for visualization

        // model lists
        this.foamModelList = []; // model to be sliced as foams
        this.everydayModelList = []; // everyday object models
        this.uuid_to_modelObj_Map = new Map(); // model uuid to model object (foamModelList and everydayModelList) map

        // 保存 GUI 控制器和对应模型之间的映射
        this.foamModelGuiMap = new Map();
        this.everydayModelGuiMap = new Map();

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
            machineDepth: 302,
            machineHeight: 402,

            // toolpath parameters
            zOffset: 12,
            deltaZ: 5,
            foamLayers: 3,
            extrusion_speed_when_foam: 70,
            printHead_speed_when_foam: 70,

            // calculated params
            nozzleDiameter: 0.4,
            dieSwelling: 1.1,
            VStar: 0,
            HStar: 0,

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

        // current selected object's mesh
        this.current_Obj_mesh = new THREE.Mesh();
        this.current_Obj = new THREE.Object3D();
        this.current_selection_type = 'foam'; // foam and sense foam

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

        // stats (show fps)
        // this.stats = new Stats();
        // this.container.appendChild(this.stats.dom);


        this.initGUI(); // initialize the GUI

        // this.initScene(); // setup the scene (add lights, printer, etc.)

        this.#lassoSelect();

        this.render();
    }

    initGUI() {
        // initialize the GUI
        initGUI(this);
    }

    // show and hide the escDiv (inform user to press esc to quit the transform mode)
    updateEscDiv() {
        const escDiv = document.getElementById('escDiv');
        if (this.transformControls.object) {
            escDiv.style.display = 'block';
            escDiv.textContent = "press esc to quit";
        } else {
            escDiv.style.display = 'none';
        }
    }

    // import STL model for foam or everyday object
    importSTLModel(type) {
        // 创建一个隐藏的 file input 元素
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.stl';
        input.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (e) => {
                const loader = new STLLoader();
                const geometry = loader.parse(e.target.result);

                // 计算 boundingBox 并获取几何中心
                geometry.computeBoundingBox();
                const bbox = geometry.boundingBox;
                const center = new THREE.Vector3();
                bbox.getCenter(center);
                const zOffset = (bbox.max.z - bbox.min.z) / 2;

                // 平移 geometry，使得其中心位于原点
                geometry.translate(-center.x, -center.y, -center.z);

                // 根据模型类型选择材质
                let material;
                if (type === 'foam') {
                    // foam model：浅绿色（0x90ee90）
                    material = new THREE.MeshStandardMaterial({ color: 0x90ee90 });
                } else if (type === 'everyday') {
                    material = new THREE.MeshStandardMaterial({ color: 0xffffff });
                }

                const mesh = new THREE.Mesh(geometry, material);

                // 将物体放置到打印板中央，
                // 注意：此时 mesh 的局部坐标原点就是模型的几何中心
                mesh.position.set(this.printer.machine_depth / 2, this.printer.machine_depth / 2, zOffset);

                // 根据 type 保存到对应数组中
                if (type === 'foam') {
                    const foamModelObj = { name: file.name, mesh: mesh, geometry: geometry };
                    this.foamModelList.push(foamModelObj);
                    this.uuid_to_modelObj_Map.set(mesh.uuid, foamModelObj);
                } else if (type === 'everyday') {
                    const everydayModelObj = { name: file.name, mesh: mesh, geometry: geometry };
                    this.everydayModelList.push(everydayModelObj);
                    this.uuid_to_modelObj_Map.set(mesh.uuid, everydayModelObj);
                }

                // 添加到场景中进行可视化
                this.scene.add(mesh);

                // 更新 GUI 中的模型列表
                if (type === 'foam') {
                    this.#refreshModelGUIList('foam');
                } else if (type === 'everyday') {
                    this.#refreshModelGUIList('everyday');
                }
            };
            reader.readAsArrayBuffer(file);
        });
        input.click();
    }

    // refresh the model list in GUI
    // listType: "foam" refresh foam models; "everyday" refresh everyday models
    #refreshModelGUIList(listType) {
        let modelList, guiFolder, itemClass;
        if (listType === 'foam') {
            modelList = this.foamModelList;
            guiFolder = this.foamModelListFolder;
            itemClass = 'foam-model-item';
        } else if (listType === 'everyday') {
            modelList = this.everydayModelList;
            guiFolder = this.everydayModelListFolder;
            itemClass = 'everyday-model-item';
        }

        // function for add delete button
        const createDeleteBtn = (modelObj, index) => {
            const deleteBtn = document.createElement('span');
            deleteBtn.innerHTML = `<img src="./assets/icons/delete.svg" alt="delete" class="delete-icon" />`;
            deleteBtn.style.cursor = 'pointer';
            deleteBtn.style.marginRight = '10px';
            deleteBtn.style.marginLeft = '10px';
            deleteBtn.title = 'delete';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 防止冒泡触发 GUI 选中事件
                // 如果当前 TransformControls 附加在该物体上，则 detach
                if (this.transformControls.object === modelObj.mesh) {
                    this.transformControls.detach();
                    this.updateEscDiv();
                }
                // 从 Three.js 场景中移除该模型
                this.scene.remove(modelObj.mesh);
                this.scene.remove(modelObj.highlightFoamMesh);
                // 从对应的数组中删除（根据 itemClass 判断是 foam 或 everyday）
                if (itemClass === 'foam-model-item') {
                    this.foamModelList.splice(index, 1);
                } else {
                    this.everydayModelList.splice(index, 1);
                }
                // refresh the model list, so the gui could also be deleted
                this.#refreshModelGUIList('foam');
                this.#refreshModelGUIList('everyday');
            });
            return deleteBtn;
        };

        // function for add transform folder
        const addTransformFolder = (modelGUIitem, modelObj, index) => {
            // add folder to modelGUIitem
            const transformFolder = modelGUIitem.addFolder('transform');
            // add class for transform folder
            transformFolder.domElement.classList.add('transform-folder');
            // add transform types for selection (move, rotate, scale); dropdown
            const transformType = { type: 'move' };
            // save the transform type to modelObj
            modelObj.transformType = 'move';
            const transformTypeController = transformFolder.add(transformType, 'type', ['move', 'rotate', 'scale']);

            // add input fields for x, y, z
            const transformX = { x: modelObj.mesh.position.x };
            const transformY = { y: modelObj.mesh.position.y };
            const transformZ = { z: modelObj.mesh.position.z };
            modelObj.transformX = transformX;
            modelObj.transformY = transformY;
            modelObj.transformZ = transformZ;
            const transformXController = transformFolder.add(transformX, 'x').name('X').listen();
            const transformYController = transformFolder.add(transformY, 'y').name('Y').listen();
            const transformZController = transformFolder.add(transformZ, 'z').name('Z').listen();

            // track modelObj.mesh.position, rotation, scale change


            transformTypeController.onChange((value) => {
                modelObj.transformType = value;
                switch (value) {
                    case 'move':
                        transformX.x = modelObj.mesh.position.x;
                        transformY.y = modelObj.mesh.position.y;
                        transformZ.z = modelObj.mesh.position.z;
                        this.transformControls.setMode("translate");
                        break;
                    case 'rotate':
                        transformX.x = modelObj.mesh.rotation.x;
                        transformY.y = modelObj.mesh.rotation.y;
                        transformZ.z = modelObj.mesh.rotation.z;
                        this.transformControls.setMode("rotate");
                        break;
                    case 'scale':
                        transformX.x = modelObj.mesh.scale.x;
                        transformY.y = modelObj.mesh.scale.y;
                        transformZ.z = modelObj.mesh.scale.z;
                        this.transformControls.setMode("scale");
                        break;
                }

            });

            transformXController.onChange(value => {
                switch (transformType.type) {
                    case 'move':
                        modelObj.mesh.position.x = value;
                        break;
                    case 'rotate':
                        modelObj.mesh.rotation.x = value;
                        break;
                    case 'scale':
                        modelObj.mesh.scale.x = value;
                        break;
                }
            });
            transformYController.onChange(value => {
                switch (transformType.type) {
                    case 'move':
                        modelObj.mesh.position.y = value;
                        break;
                    case 'rotate':
                        modelObj.mesh.rotation.y = value;
                        break;
                    case 'scale':
                        modelObj.mesh.scale.y = value;
                        break;
                }
            });
            transformZController.onChange(value => {
                switch (transformType.type) {
                    case 'move':
                        modelObj.mesh.positio
                    case 'rotate':
                        modelObj.mesh.rotation.z = value;
                        break;
                    case 'scale':
                        modelObj.mesh.scale.z = value;
                        break;
                }
            });
            transformFolder.close();
        }

        // function to add selected mesh folder
        const addSelectedMeshFolder = (modelGUIitem, modelObj, index) => {
            const selectedMeshFolder = modelGUIitem.addFolder('mesh selection'); // add folder to modelGUIitem
            selectedMeshFolder.domElement.classList.add('mesh-selection-folder'); // add class for selected mesh folder

            const selectFoamMesh = (modelObj) => {
                modelObj.mesh.geometry.boundsTree = new MeshBVH(modelObj.geometry);

                this.current_Obj = modelObj;
                this.current_selection_type = 'foam'; // set current selection type to foam
                if (!this.current_Obj.highlightFoamMesh) {
                    this.current_Obj.highlightFoamMesh = new THREE.Mesh();
                    this.current_Obj.highlightFoamMesh.geometry = modelObj.mesh.geometry.clone();
                    this.current_Obj.highlightFoamMesh.geometry.drawRange.count = 0;
                    this.current_Obj.highlightFoamMesh.material = new THREE.MeshBasicMaterial({
                        opacity: 0.3,
                        transparent: true,
                        depthWrite: false,
                        wireframe: false,
                    });
                    this.current_Obj.highlightFoamMesh.material.color.set(0xff9800).convertSRGBToLinear();
                    this.current_Obj.highlightFoamMesh.renderOrder = 1;
                    this.current_Obj.highlightFoamMesh.position.copy(modelObj.mesh.position);
                    this.current_Obj.highlightFoamMesh.rotation.copy(modelObj.mesh.rotation);
                    this.current_Obj.highlightFoamMesh.scale.copy(modelObj.mesh.scale);

                    // add highlight mesh to the scene
                    this.scene.add(this.current_Obj.highlightFoamMesh);
                }

            };

            const selectSenseMesh = (modelObj) => {
                if (!modelObj.mesh.geometry.boundsTree) {
                    modelObj.mesh.geometry.boundsTree = new MeshBVH(modelObj.geometry);
                }

                this.current_Obj = modelObj;
                this.current_selection_type = 'sense'; // set current selection type to sense
                if (!this.current_Obj.highlightSenseMesh) {
                    this.current_Obj.highlightSenseMesh = new THREE.Mesh();
                    this.current_Obj.highlightSenseMesh.geometry = modelObj.mesh.geometry.clone();
                    this.current_Obj.highlightSenseMesh.geometry.drawRange.count = 0;
                    this.current_Obj.highlightSenseMesh.material = new THREE.MeshBasicMaterial({
                        opacity: 0.6,
                        transparent: true,
                        depthWrite: false,
                        wireframe: false,
                    });
                    this.current_Obj.highlightSenseMesh.material.color.set(0x000000).convertSRGBToLinear();
                    this.current_Obj.highlightSenseMesh.renderOrder = 1;
                    this.current_Obj.highlightSenseMesh.position.copy(modelObj.mesh.position);
                    this.current_Obj.highlightSenseMesh.rotation.copy(modelObj.mesh.rotation);
                    this.current_Obj.highlightSenseMesh.scale.copy(modelObj.mesh.scale);

                    // add highlight mesh to the scene
                    this.scene.add(this.current_Obj.highlightSenseMesh);
                }

            }

            // add button to select mesh
            const selectMeshBtn = { selectFoamMesh: () => selectFoamMesh(modelObj), selectSenseMesh: () => selectSenseMesh(modelObj) };
            selectedMeshFolder.add(selectMeshBtn, 'selectFoamMesh').name('Select Regular Foam Area');
            selectedMeshFolder.add(selectMeshBtn, 'selectSenseMesh').name('Select Sense Foam Area');

        }

        // function to add params folder
        const addParamsFolder = (modelGUIitem, modelObj, index) => {
            const paramsFolder = modelGUIitem.addFolder('params'); // add folder to modelGUIitem
            paramsFolder.domElement.classList.add('params-folder'); // add class for params folder
            // add input fields for x, y, z
        };

        // clear existing items
        const items = document.querySelectorAll('.' + itemClass);
        items.forEach(item => item.remove());

        // create GUI items for each model
        modelList.forEach((modelObj, index) => {
            const modelGUIitem = guiFolder.addFolder(modelObj.name);
            modelGUIitem.domElement.classList.add(itemClass); // add class for styling
            modelObj.guiItem = modelGUIitem; // bind modelGUIitem to modelObj

            // modelGUIitem add delete button
            modelGUIitem.domElement.querySelector('.title').appendChild(createDeleteBtn(modelObj, index));

            addTransformFolder(modelGUIitem, modelObj, index); // modelGUIitem add transform folder
            if (listType === 'everyday') {
                addSelectedMeshFolder(modelGUIitem, modelObj, index); // modelGUIitem add selected mesh folder
                addParamsFolder(modelGUIitem, modelObj, index); // add params folder
            }


        });

    }


    // save gcode to file 
    #saveGcodeToFile(gcode, filename) {
        // 创建一个 Blob 对象，其中包含 G-code 数据
        const blob = new Blob([gcode], { type: 'text/plain' });

        // 创建一个链接并将其设置为指向 Blob
        const link = document.createElement('a');
        link.style.display = 'none';
        link.href = URL.createObjectURL(blob);
        link.download = filename + '.gcode'; // 指定下载文件名

        // 添加链接到文档，触发点击，然后移除
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // 清理 Blob URL
        URL.revokeObjectURL(link.href);
    }

    // customize gcode (start and end gcode)
    #customizeGcode() {


    }

    // set up the scene
    initScene(setlight = true, setPrintBase = true) {
        const addLights = () => {
            const light = new THREE.DirectionalLight(0xffffff, 1);
            light.castShadow = true;
            light.shadow.mapSize.set(2048, 2048);
            light.position.set(10, 10, 10);
            this.scene.add(light);
            this.scene.add(new THREE.AmbientLight(0xffffff, 1));
        }
        const drawPrintBase = () => {
            // remove the previous printer base objects
            this.printBaseObjects.forEach(obj => {
                this.scene.remove(obj);
                if (obj.geometry) obj.geometry.dispose(); // 如果对象包含几何体，释放资源
                if (obj.material) obj.material.dispose(); // 如果对象包含材料，释放资源
                if (obj.texture) obj.texture.dispose(); // 如果对象包含纹理，释放资源
            });
            this.printBaseObjects = []; // reset the printer base objects

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
            this.printBaseObjects.push(line);

            // add origin point
            const originGeometry = new THREE.SphereGeometry(2);
            const originMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
            const originSphere = new THREE.Mesh(originGeometry, originMaterial);
            this.scene.add(originSphere);
            this.printBaseObjects.push(originSphere);

            // Create an AxesHelper
            const axesHelper = new THREE.AxesHelper(50); // The parameter defines the length of each axis line

            // Add the AxesHelper to the scene
            this.scene.add(axesHelper);
            this.printBaseObjects.push(axesHelper);
        }
        if (setlight) addLights();
        if (setPrintBase) drawPrintBase();
    }


    // select model
    #selectModel() {

    }

    // move models with trasform controls
    #moveModels() {
        this.renderer.domElement.addEventListener('pointerdown', (event) => {
            const mouse = new THREE.Vector2();
            mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
            mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(mouse, this.camera);

            // 获取场景中所有可交互对象，但排除 TransformControls 和打印机 bounding box 对象
            // const selectableObjects = this.scene.children.filter(obj =>
            //     obj !== this.transformControls && !this.printBaseObjects.includes(obj)
            // );

            // selecteable objects are in foamModelList and everydayModelList
            const selectableObjects = [];
            this.foamModelList.forEach(model => selectableObjects.push(model.mesh));
            this.everydayModelList.forEach(model => selectableObjects.push(model.mesh));


            const intersects = raycaster.intersectObjects(selectableObjects, true);
            if (intersects.length > 0) {
                const selected = intersects[0].object;
                console.log(intersects[0]);
                if (this.transformControls.object !== selected) {
                    this.transformControls.detach();
                    this.transformControls.attach(selected);
                    this.transformControls.setMode('translate');
                    this.updateEscDiv();
                }
                // 更新 GUI 高亮：先清除所有 GUI 项的高亮，再根据 selected 对象更新对应项
                document.querySelectorAll('.foam-model-item, .everyday-model-item').forEach(elem => {
                    elem.classList.remove('selectedModel');
                });
                if (this.foamModelGuiMap.has(selected.uuid)) {
                    const item = this.foamModelGuiMap.get(selected.uuid);
                    item.domElement.classList.add('selectedModel');
                    // 显示 transform panel, find .transform-panel class under item.domElement
                    item.domElement.querySelector('.transform-panel').style.display = 'flex';

                } else if (this.everydayModelGuiMap.has(selected.uuid)) {
                    const item = this.everydayModelGuiMap.get(selected.uuid);
                    item.domElement.classList.add('selectedModel');
                    // 显示 transform panel
                    item.domElement.querySelector('.transform-panel').style.display = 'flex';
                }
            }

            // 按 Esc 键取消选择
            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    this.transformControls.detach();
                    this.updateEscDiv();
                    document.querySelectorAll('.foam-model-item, .everyday-model-item').forEach(elem => {
                        elem.classList.remove('selectedModel');
                    });
                    // hide all transform-panel
                    document.querySelectorAll('.transform-panel').forEach(panel => {
                        panel.style.display = 'none';
                    });
                }
            });
        });

        // 这里添加 TransformControls 的 "change" 事件，只有当拖动时更新 GUI 输入框数值
        this.transformControls.addEventListener('change', () => {
            console.log('transform change');
            // find selected object in foamModelList or everydayModelList

            if (this.transformControls.object) {
                const mesh = this.transformControls.object;
                let obj = this.uuid_to_modelObj_Map.get(mesh.uuid);
                // update GUI item transform panel
                if (obj) {
                    const mode = obj.transformType;
                    if (mode === 'move') {
                        obj.transformX.x = mesh.position.x.toFixed(2);
                        obj.transformY.y = mesh.position.y.toFixed(2);
                        obj.transformZ.z = mesh.position.z.toFixed(2);
                    } else if (mode === 'rotate') {
                        obj.transformX.x = mesh.rotation.x.toFixed(2);
                        obj.transformY.y = mesh.rotation.y.toFixed(2);
                        obj.transformZ.z = mesh.rotation.z.toFixed(2);
                    } else if (mode === 'scale') {
                        obj.transformX.x = mesh.scale.x.toFixed(2);
                        obj.transformY.y = mesh.scale.y.toFixed(2);
                        obj.transformZ.z = mesh.scale.z.toFixed(2);
                    }

                    // update highlight mesh (highlightFoamMesh move with selected mesh)
                    if (obj.highlightFoamMesh) {
                        obj.highlightFoamMesh.position.copy(mesh.position);
                        obj.highlightFoamMesh.rotation.copy(mesh.rotation);
                        obj.highlightFoamMesh.scale.copy(mesh.scale);
                    }

                    if (obj.highlightSenseMesh) {
                        obj.highlightSenseMesh.position.copy(mesh.position);
                        obj.highlightSenseMesh.rotation.copy(mesh.rotation);
                        obj.highlightSenseMesh.scale.copy(mesh.scale);
                    }

                    // update pointsMesh
                    if (obj.pointsMesh) {
                        obj.pointsMesh.position.copy(mesh.position);
                        obj.pointsMesh.rotation.copy(mesh.rotation);
                        obj.pointsMesh.scale.copy(mesh.scale);
                    }
                }

                // let guiItem = this.foamModelGuiMap.get(mesh.uuid) || this.everydayModelGuiMap.get(mesh.uuid);
                // if (guiItem && guiItem.transformPanel) {
                //     const mode = guiItem.currentMode || 'translate';
                //     // 这里只更新输入框数值，注意：如果你正在手动输入时，不要在变化中覆盖
                //     // 可以判断一个状态变量，例如 this.isDragging，或者在输入框 focus 时暂不更新
                //     if (mode === 'translate') {
                //         mesh.geometry.computeBoundingBox();
                //         const bbox = mesh.geometry.boundingBox;
                //         const localBottomCenter = new THREE.Vector3(
                //             (bbox.min.x + bbox.max.x) / 2,
                //             (bbox.min.y + bbox.max.y) / 2,
                //             bbox.min.z
                //         );
                //         const worldBottomCenter = localBottomCenter.clone().applyMatrix4(mesh.matrixWorld);
                //         guiItem.transformPanel.querySelector('.input-x').value = worldBottomCenter.x.toFixed(2);
                //         guiItem.transformPanel.querySelector('.input-y').value = worldBottomCenter.y.toFixed(2);
                //         guiItem.transformPanel.querySelector('.input-z').value = worldBottomCenter.z.toFixed(2);
                //     } else if (mode === 'rotate') {
                //         guiItem.transformPanel.querySelector('.input-x').value = THREE.MathUtils.radToDeg(mesh.rotation.x).toFixed(2);
                //         guiItem.transformPanel.querySelector('.input-y').value = THREE.MathUtils.radToDeg(mesh.rotation.y).toFixed(2);
                //         guiItem.transformPanel.querySelector('.input-z').value = THREE.MathUtils.radToDeg(mesh.rotation.z).toFixed(2);
                //     } else if (mode === 'scale') {
                //         guiItem.transformPanel.querySelector('.input-x').value = mesh.scale.x.toFixed(2);
                //         guiItem.transformPanel.querySelector('.input-y').value = mesh.scale.y.toFixed(2);
                //         guiItem.transformPanel.querySelector('.input-z').value = mesh.scale.z.toFixed(2);
                //     }
                // }
            }
        });
    }


    render = () => {
        // this.stats.update();
        // print camera position, lookat, up vector
        // console.log(`Position: ${this.camera.position.toArray().join(', ')}, Direction: ${this.camera.getWorldDirection(new THREE.Vector3()).toArray().join(', ')}, Up: ${this.camera.up.toArray().join(', ')}`);

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
                this.#updateSelection(this.current_Obj);
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
    #updateSelection(object) {
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
            .copy(object.mesh.matrixWorld)
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

        invWorldMatrix.copy(object.mesh.matrixWorld).invert();
        camLocalPosition.set(0, 0, 0).applyMatrix4(this.camera.matrixWorld).applyMatrix4(invWorldMatrix);


        const indices = []; // store the selected faces indices
        object.mesh.geometry.boundsTree.shapecast({
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

                            const res = object.mesh.geometry.boundsTree.raycastFirst(tempRay, THREE.DoubleSide);
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

        const indexAttr = object.mesh.geometry.index;
        const newIndexAttr = (this.current_selection_type === 'foam') ? object.highlightFoamMesh.geometry.index : object.highlightSenseMesh.geometry.index;
        if (indices.length && this.selectParams.selectModel) {
            // if we found indices and we want to select the whole model
            for (let i = 0, l = indexAttr.count; i < l; i++) {
                const i2 = indexAttr.getX(i);
                newIndexAttr.setX(i, i2);
            }
            if (this.current_selection_type === 'foam') {
                object.highlightFoamMesh.geometry.drawRange.count = Infinity;
            } else {
                object.highlightSenseMesh.geometry.drawRange.count = Infinity;
            }
            // object.highlightFoamMesh.geometry.drawRange.count = Infinity;
            newIndexAttr.needsUpdate = true;

        } else {
            // update the highlight object.mesh
            for (let i = 0, l = indices.length; i < l; i++) {
                const i2 = indexAttr.getX(indices[i]);
                newIndexAttr.setX(i, i2);
            }
            if (this.current_selection_type === 'foam') {
                object.highlightFoamMesh.geometry.drawRange.count = indices.length;
            } else {
                object.highlightSenseMesh.geometry.drawRange.count = indices.length;
            }

            newIndexAttr.needsUpdate = true;
        }


        if (this.current_selection_type === 'foam') {
            object.selectedRegularFoamMesh = this.#createSelectedMeshFromHighlight(object.highlightFoamMesh); // create selected object.mesh
        } else {
            object.selectedSenseFoamMesh = this.#createSelectedMeshFromHighlight(object.highlightSenseMesh); // create selected object.mesh
        }
        // object.selectedRegularFoamMesh = this.#createSelectedMeshFromHighlight(object.highlightFoamMesh); // create selected object.mesh
        // this.selectedMesh.position.set(this.targetX, this.targetY, this.targetZ); // translate the selected object.mesh

        this.#updateSelectedMeshBoundingBox(object); // update selected object.mesh bounding box

        this.#sampleSelectedMesh(object); // sample selected object.mesh
        console.log(object)
        this.#generateFoamToolpath(object); // generate foam toolpath
        // this.createZigzagPath(); // create zigzag toolpath based on the sample points
        // this.#visualizeToolpath(this.toolpathZigzagPath); // visualize the toolpath

        // // visualize the bounding box of the selected object.mesh
        // if (this.selectParams.selectBoundingBox) {
        //     // visualize the bounding box of the selected object.mesh
        //     this.scene.add(this.selectedRegularFoamMeshBoundingBoxHelper);
        // }
        // else {
        //     // remove the bounding box of the selected object.mesh
        //     if (this.selectedRegularFoamMeshBoundingBoxHelper) {
        //         this.scene.remove(this.selectedRegularFoamMeshBoundingBoxHelper);
        //     }
        // }
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
        // this.selectedMesh = new THREE.Mesh(selectedGeometry, selectedMeshMaterial);
        // return this.selectedMesh;
        return new THREE.Mesh(selectedGeometry, selectedMeshMaterial);
    }




    // update the bounding box of the selected mesh
    #updateSelectedMeshBoundingBox(object) {
        // 移除先前的边界盒（如果存在）
        if (object.selectedRegularFoamMeshBoundingBoxHelper) {
            this.scene.remove(object.selectedRegularFoamMeshBoundingBoxHelper);
            object.selectedRegularFoamMeshBoundingBoxHelper.geometry.dispose();
            object.selectedRegularFoamMeshBoundingBoxHelper.material.dispose();
        }

        // 创建新的边界盒
        const box = new THREE.Box3().setFromObject(object.selectedRegularFoamMesh);
        object.selectedRegularFoamMeshBoundingBoxHelper = new THREE.Box3Helper(box, 0xff0000);
    }

    // sample the selected mesh (simple grid sampling method, scanning X&Y)
    #sampleSelectedMesh(object) {
        const bbox = object.selectedRegularFoamMeshBoundingBoxHelper.box;
        const gridSize = this.sampleStep;
        const vertices_foam = [];
        const vertices_sense = [];
        object.toolpathSamplePoints = []; // clear the toolpath sample points

        const pointsMaterialFoam = new THREE.PointsMaterial({
            size: 4,
            color: 0xff0000 // red points for foam
        });
        const pointsMaterialSense = new THREE.PointsMaterial({
            size: 4,
            color: 0x000000 // black points for sense
        });

        const pointsGeometry_foam = new THREE.BufferGeometry();
        const pointsGeometry_sense = new THREE.BufferGeometry();

        // grid sample the selected mesh
        for (let x = bbox.min.x; x <= bbox.max.x; x += gridSize) {
            for (let y = bbox.min.y; y <= bbox.max.y; y += gridSize) {
                // create a ray from the top of the bounding box
                const rayOrigin = new THREE.Vector3(x, y, bbox.max.z + 10);
                const rayDirection = new THREE.Vector3(0, 0, -1);
                const raycaster = new THREE.Raycaster(rayOrigin, rayDirection);

                // check if the ray intersects the selected mesh
                const intersectsFoam = (object.selectedRegularFoamMesh) ? raycaster.intersectObject(object.selectedRegularFoamMesh) : [];
                // check if the ray intersects the selected sense mesh

                const intersectsSense = (object.selectedSenseFoamMesh) ? raycaster.intersectObject(object.selectedSenseFoamMesh) : [];

                if (intersectsFoam.length > 0 && intersectsSense.length > 0) { // if the ray intersects both foam and sense mesh
                    // get the first intersection point
                    const point = intersectsFoam[0].point;

                    object.toolpathSamplePoints.push({ point: point, type: 'sense' });
                    vertices_sense.push(point.x, point.y, point.z); // add the point to the vertices
                }
                else if (intersectsFoam.length > 0 && intersectsSense.length === 0) { // if the ray intersects only foam mesh
                    const point = intersectsFoam[0].point;

                    object.toolpathSamplePoints.push({ point: point, type: 'foam' });
                    vertices_foam.push(point.x, point.y, point.z); // add the point to the vertices
                }
            }
        }

        // set the vertices to the geometry
        pointsGeometry_foam.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(vertices_foam, 3)
        );
        pointsGeometry_sense.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(vertices_sense, 3)
        );

        // create a points mesh
        const pointsMesh_foam = new THREE.Points(pointsGeometry_foam, pointsMaterialFoam);
        const pointsMesh_sense = new THREE.Points(pointsGeometry_sense, pointsMaterialSense);
        this.scene.add(pointsMesh_foam);
        this.scene.add(pointsMesh_sense);


        // console.log(this.toolpathSamplePoints);
        // this.#findCornerPoints(); // find corner points of the toolpath sample points

        // remove the previous points mesh
        if (object.pointsMesh_foam) {
            this.scene.remove(object.pointsMesh_foam);
            object.pointsMesh_foam.geometry.dispose();
            object.pointsMesh_foam.material.dispose();
        }
        object.pointsMesh_foam = pointsMesh_foam; // store the points mesh

        // set pointsmesh position the same with mesh position  object.pointsMesh.position=object.mesh.position
        object.pointsMesh_foam.position.copy(object.mesh.position);

        // remove the previous points mesh
        if (object.pointsMesh_sense) {
            this.scene.remove(object.pointsMesh_sense);
            object.pointsMesh_sense.geometry.dispose();
            object.pointsMesh_sense.material.dispose();
        }
        object.pointsMesh_sense = pointsMesh_sense; // store the points mesh

        // set pointsmesh position the same with mesh position  object.pointsMesh.position=object.mesh.position
        object.pointsMesh_sense.position.copy(object.mesh.position);


    }

    #generateFoamToolpath(object) {
        // --- 1. 删除之前的 foamToolpathLine ---
        if (object.foamToolpathLine) {
            this.scene.remove(object.foamToolpathLine);
            object.foamToolpathLine.traverse(child => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) child.material.dispose();
            });
        }
        if (!object.toolpathSamplePoints || object.toolpathSamplePoints.length === 0) {
            console.warn("没有采样点，无法生成工具路径。");
            return;
        }

        // --- 2. 定义 offsets，新值如下 ---
        const offsets = {
            all: 10,
            foam: 20,
            sense: 30
        };

        const self = this;
        // --- 3. 定义辅助函数：根据传入的点数组（数组元素形如 { point: Vector3, type: string }）生成连续路径 ---
        function generatePath(filteredPoints) {
            const step = self.sampleStep;            // 采样步长
            const maxConnectDist = step * 3;           // 用于拆分行内点的依据（此处仅用于分行，不做跨行距离判断）
            const rowTol = step * 0.5;                 // 同一行的 y 容差

            // 按 y 坐标排序并分行
            let sortedPoints = filteredPoints.slice().sort((a, b) => a.point.y - b.point.y);
            let rows = [];
            let currentRow = [sortedPoints[0]];
            for (let i = 1; i < sortedPoints.length; i++) {
                const prev = sortedPoints[i - 1];
                const cur = sortedPoints[i];
                if (Math.abs(cur.point.y - prev.point.y) <= rowTol) {
                    currentRow.push(cur);
                } else {
                    rows.push(currentRow);
                    currentRow = [cur];
                }
            }
            rows.push(currentRow);

            // 对每一行按 x 排序，并拆分行内间隔过大的情况
            // 将结果存入 rowSegments 对象，键为行号（索引），值为该行中拆分后的小段数组，每个小段对象为 { points:[…], connected:false }
            let rowSegments = {};
            rows.forEach((row, rowIndex) => {
                rowSegments[rowIndex] = [];
                row.sort((a, b) => a.point.x - b.point.x);
                let segs = [];
                let currentSeg = [row[0]];
                for (let i = 1; i < row.length; i++) {
                    const prev = row[i - 1];
                    const cur = row[i];
                    if ((cur.point.x - prev.point.x) <= maxConnectDist) {
                        currentSeg.push(cur);
                    } else {
                        segs.push(currentSeg);
                        currentSeg = [cur];
                    }
                }
                if (currentSeg.length > 0) {
                    segs.push(currentSeg);
                }
                // 为达到 zigzag 效果，奇数行反转每个小段
                if (rowIndex % 2 === 1) {
                    segs = segs.map(segment => segment.slice().reverse());
                }
                segs.forEach(seg => {
                    rowSegments[rowIndex].push({ points: seg, connected: false });
                });
            });
            const maxRow = rows.length;

            // --- 4. 跨行构造连续路径 ---
            const globalSegments = [];  // 最终连续路径数组，每项为点数组
            // 辅助函数：判断是否还有未连接的小段
            function existUnconnected() {
                for (let r = 0; r < maxRow; r++) {
                    if (rowSegments[r].some(seg => seg.connected === false)) return true;
                }
                return false;
            }

            // 外层循环：每次构造一条连续路径
            while (existUnconnected()) {
                // 找到行号最小且有未连接段的行，取第一个未连接段作为起点
                let startRow = null, startSeg = null;
                for (let r = 0; r < maxRow; r++) {
                    for (let seg of rowSegments[r]) {
                        if (!seg.connected) {
                            startRow = r;
                            startSeg = seg;
                            break;
                        }
                    }
                    if (startRow !== null) break;
                }
                if (startRow === null) break;

                // 初始化当前全局路径，从 startRow 开始
                let currentGlobal = (startRow % 2 === 0) ? startSeg.points.slice() : startSeg.points.slice().reverse();
                startSeg.connected = true;
                let currentPt = currentGlobal[currentGlobal.length - 1];
                // 记录当前段的追加顺序：若起始行为偶数则认为是 "normal"，奇数则 "reverse"
                let currentOrder = (startRow % 2 === 0) ? "normal" : "reverse";
                let currentRow = startRow;

                // 尝试从下一行开始连接
                for (let r = currentRow + 1; r < maxRow; r++) {
                    let candidates = rowSegments[r].filter(seg => !seg.connected);
                    if (candidates.length === 0) {
                        // 如果该行全都已连接，则另起一条连续路径，退出本轮构造
                        break;
                    }
                    // 判断1：遍历候选中，寻找与 currentPt 的距离最小者（这里使用简单的 Manhattan 距离计算）
                    let bestCandidate = null, bestDist = Infinity, candidateOrder = null;
                    candidates.forEach(seg => {
                        let head = seg.points[0];
                        let tail = seg.points[seg.points.length - 1];
                        let dHead = Math.abs(currentPt.point.x - head.point.x) + Math.abs(currentPt.point.y - head.point.y);
                        let dTail = Math.abs(currentPt.point.x - tail.point.x) + Math.abs(currentPt.point.y - tail.point.y);
                        if (dHead < bestDist) {
                            bestCandidate = seg;
                            bestDist = dHead;
                            candidateOrder = "normal";
                        }
                        if (dTail < bestDist) {
                            bestCandidate = seg;
                            bestDist = dTail;
                            candidateOrder = "reverse";
                        }
                    });
                    if (bestCandidate) {
                        let segPts = bestCandidate.points.slice();
                        if (candidateOrder === "reverse") {
                            segPts.reverse();
                        }
                        currentGlobal = currentGlobal.concat(segPts);
                        currentPt = currentGlobal[currentGlobal.length - 1];
                        currentOrder = candidateOrder;
                        bestCandidate.connected = true;
                    } else {
                        // 判断2：如果判断1无合适候选，则根据当前追加顺序选择
                        let chosen = null;
                        if (currentOrder === "normal") {
                            let segs = rowSegments[r];
                            if (segs.length > 0 && !segs[segs.length - 1].connected) {
                                chosen = segs[segs.length - 1];
                                candidateOrder = "reverse";
                            }
                        } else { // currentOrder === "reverse"
                            let segs = rowSegments[r];
                            if (segs.length > 0 && !segs[0].connected) {
                                chosen = segs[0];
                                candidateOrder = "normal";
                            }
                        }
                        if (chosen) {
                            let segPts = chosen.points.slice();
                            if (candidateOrder === "reverse") {
                                segPts.reverse();
                            }
                            currentGlobal = currentGlobal.concat(segPts);
                            currentPt = currentGlobal[currentGlobal.length - 1];
                            currentOrder = candidateOrder;
                            chosen.connected = true;
                        } else {
                            break;
                        }
                    }
                }
                globalSegments.push(currentGlobal);
            }

            return globalSegments;
        } // end generatePath

        // --- 5. 生成三种工具路径 ---
        let allPoints = object.toolpathSamplePoints;  // 全部点
        let foamPoints = object.toolpathSamplePoints.filter(item => item.type === 'foam');
        let sensePoints = object.toolpathSamplePoints.filter(item => item.type === 'sense');

        let globalSegmentsAll = generatePath(allPoints);
        let globalSegmentsFoam = generatePath(foamPoints);
        let globalSegmentsSense = generatePath(sensePoints);

        // --- 6. 可视化 ---
        // 定义可视化函数：将 globalSegments 转换为 THREE.Line 或 THREE.Group，并设置 z offset
        function visualizeSegments(globalSegments, defaultColor, zOffset) {
            if (globalSegments.length === 0) return null;
            let obj;
            if (globalSegments.length === 1) {
                let vertices = [];
                globalSegments[0].forEach(item => {
                    vertices.push(item.point.x, item.point.y, item.point.z);
                });
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
                const material = new THREE.LineBasicMaterial({ color: defaultColor });
                obj = new THREE.Line(geometry, material);
            } else {
                obj = new THREE.Group();
                const palette = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff];
                globalSegments.forEach((seg, idx) => {
                    let vertices = [];
                    seg.forEach(item => {
                        vertices.push(item.point.x, item.point.y, item.point.z);
                    });
                    const geometry = new THREE.BufferGeometry();
                    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices), 3));
                    const material = new THREE.LineBasicMaterial({ color: palette[idx % palette.length] });
                    const line = new THREE.Line(geometry, material);
                    obj.add(line);
                });
            }
            obj.position.set(0, 0, zOffset);
            return obj;
        }

        // 如果所有采样点都是 foam，则只生成并可视化 foam 的路径
        let parentGroup;
        if (object.toolpathSamplePoints.every(item => item.type === 'foam')) {
            parentGroup = visualizeSegments(globalSegmentsFoam, 0x00ff00, offsets.foam);
        } else {
            let toolpathAll = visualizeSegments(globalSegmentsAll, 0xff00ff, offsets.all);
            let toolpathFoam = visualizeSegments(globalSegmentsFoam, 0x00ff00, offsets.foam);
            let toolpathSense = visualizeSegments(globalSegmentsSense, 0x0000ff, offsets.sense);
            parentGroup = new THREE.Group();
            if (toolpathAll) parentGroup.add(toolpathAll);
            if (toolpathFoam) parentGroup.add(toolpathFoam);
            if (toolpathSense) parentGroup.add(toolpathSense);
        }
        if (object.mesh && object.mesh.position) {
            parentGroup.position.copy(object.mesh.position);
        }
        this.scene.add(parentGroup);
        object.foamToolpathLine = parentGroup;

        console.log("生成的工具路径：", {
            all: globalSegmentsAll,
            foam: globalSegmentsFoam,
            sense: globalSegmentsSense
        });

        return {
            all: globalSegmentsAll,
            foam: globalSegmentsFoam,
            sense: globalSegmentsSense
        };
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
            this.orbitControls.enabled = true; // ebable orbit controls

            this.selectionShape.visible = false;
            this.dragging = false;
            if (this.selectionPoints.length) {
                this.selectionNeedsUpdate = true;
            }
        });

        this.renderer.domElement.addEventListener('pointermove', e => {
            // console.log(e.metaKey);
            // If the left mouse button is not pressed
            if ((1 & e.buttons) === 0 || !e.altKey) {
                return;
            }

            //disable orbit controls
            this.orbitControls.enabled = false;

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