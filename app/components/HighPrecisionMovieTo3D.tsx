import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { MeshBVH, MeshBVHVisualizer } from 'three-mesh-bvh';

interface Feature {
  point: THREE.Vector3;
  descriptor: Float32Array;
  frameIndex: number;
}

interface CameraParams {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  fov: number;
}

interface ReconstructionState {
  features: Feature[];
  cameras: CameraParams[];
  sparse: THREE.Points | null;
  dense: THREE.Points | null;
  mesh: THREE.Mesh | null;
}

const HighPrecisionMovieTo3D = () => {
  const mountRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [videoLoaded, setVideoLoaded] = useState(false);
  
  const [reconstruction, setReconstruction] = useState<ReconstructionState>({
    features: [],
    cameras: [],
    sparse: null,
    dense: null,
    mesh: null
  });

  // Initialize Three.js scene
  useEffect(() => {
    if (!mountRef.current) return;

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    sceneRef.current = scene;

    // Camera setup
    const camera = new THREE.PerspectiveCamera(
      75,
      mountRef.current.clientWidth / mountRef.current.clientHeight,
      0.1,
      1000
    );
    camera.position.set(0, 0, 5);
    cameraRef.current = camera;

    // Renderer setup
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controlsRef.current = controls;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(2, 2, 5);
    scene.add(directionalLight);

    // Grid helper
    const gridHelper = new THREE.GridHelper(10, 10);
    scene.add(gridHelper);

    // Animation loop
    const animate = () => {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Handle window resize
    const handleResize = () => {
      if (!mountRef.current || !camera || !renderer) return;
      
      camera.aspect = mountRef.current.clientWidth / mountRef.current.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      mountRef.current?.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, []);

  // Handle file selection
  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    if (videoRef.current) {
      videoRef.current.src = url;
      videoRef.current.onloadeddata = () => {
        setVideoLoaded(true);
        processVideo(); // Automatically start processing when video is loaded
      };
    }

    return () => URL.revokeObjectURL(url);
  };

  const processVideo = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !sceneRef.current) return;

    setProcessing(true);
    setStage('Starting video processing...');
    setProgress(0);

    try {
      // Wait for video metadata
      await new Promise<void>((resolve) => {
        if (video.readyState >= 2) {
          resolve();
        } else {
          video.onloadeddata = () => resolve();
        }
      });

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not get canvas context');

      // Set canvas size to match video
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      // Initialize point cloud
      const geometry = new THREE.BufferGeometry();
      const material = new THREE.PointsMaterial({
        size: 0.02,
        vertexColors: true,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending
      });

      // Clear existing point clouds
      const existingPoints = sceneRef.current.children.filter(
        child => child instanceof THREE.Points
      );
      existingPoints.forEach(point => sceneRef.current?.remove(point));

      // Process video frames
      const frameCount = Math.floor(video.duration * 30); // 30 fps
      const pointsPerFrame = 100;
      let currentFrame = 0;
      let positions: number[] = [];
      let colors: number[] = [];
      
      // Function to process a single frame
      const processFrame = async (time: number): Promise<void> => {
        return new Promise((resolve) => {
          video.currentTime = time;
          video.onseeked = () => {
            // Draw frame to canvas
            ctx.drawImage(video, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const pixels = imageData.data;

            // Try multiple random positions until we find enough valid points
            let attempts = 0;
            let pointsAdded = 0;
            while (pointsAdded < pointsPerFrame && attempts < pointsPerFrame * 3) {
              attempts++;

              // Random pixel position
              const x = Math.floor(Math.random() * canvas.width);
              const y = Math.floor(Math.random() * canvas.height);
              const pixelIndex = (y * canvas.width + x) * 4;

              // Get color from pixel
              const r = pixels[pixelIndex] / 255;
              const g = pixels[pixelIndex + 1] / 255;
              const b = pixels[pixelIndex + 2] / 255;
              
              // Skip white or near-white pixels
              const brightness = (r + g + b) / 3;
              const colorVariance = Math.max(
                Math.abs(r - g),
                Math.abs(g - b),
                Math.abs(b - r)
              );

              // Skip if the color is too bright or has low variance
              if (brightness > 0.9 || colorVariance < 0.1) continue;

              // Calculate 3D position with minimal Z-depth
              const xPos = (x / canvas.width) * 4 - 2;
              // Invert Y coordinate (multiply by -1)
              const yPos = -((y / canvas.height) * 4 - 2);
              // Reduce Z-depth significantly
              const zPos = ((time / video.duration) * 0.2) - 0.1;

              positions.push(xPos, yPos, zPos);
              colors.push(r, g, b);
              pointsAdded++;
            }

            resolve();
          };
        });
      };

      // Process frames sequentially
      const updatePointCloud = async () => {
        if (currentFrame < frameCount) {
          const time = currentFrame / 30;
          await processFrame(time);
          
          // Update geometry
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
          geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

          // Create or update point cloud
          if (!sceneRef.current.children.some(child => child instanceof THREE.Points)) {
            const pointCloud = new THREE.Points(geometry, material);
            sceneRef.current.add(pointCloud);
          }

          // Update progress
          currentFrame++;
          setProgress((currentFrame / frameCount) * 100);
          
          // Schedule next frame
          requestAnimationFrame(updatePointCloud);
        } else {
          setProcessing(false);
          setStage('Processing complete');
        }
      };

      // Start processing
      video.currentTime = 0;
      updatePointCloud();

      // Set camera position for flatter view
      if (cameraRef.current) {
        cameraRef.current.position.set(0, 0, 5); // Changed camera position for front view
        cameraRef.current.lookAt(0, 0, 0);
      }

      // Configure controls
      if (controlsRef.current) {
        controlsRef.current.autoRotate = true;
        controlsRef.current.autoRotateSpeed = 0.5; // Slower rotation
        controlsRef.current.enableDamping = true;
        controlsRef.current.dampingFactor = 0.05;
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setProcessing(false);
    }
  };

  return (
    <div className="relative w-full h-full">
      {/* Main 3D view container */}
      <div 
        ref={mountRef} 
        className="w-full h-full bg-black"
      >
        <canvas ref={canvasRef} className="hidden" />
      </div>

      {/* Source video minimap */}
      <div className="absolute top-4 right-4 w-48 h-auto bg-black rounded-lg overflow-hidden shadow-lg border border-gray-700">
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          playsInline
          style={{ opacity: videoLoaded ? 1 : 0 }}
        />
      </div>

      {/* Upload button and progress */}
      <div className="absolute bottom-4 left-4 space-y-2">
        <input
          type="file"
          accept="video/*"
          onChange={handleFileSelect}
          className="hidden"
          id="video-upload"
        />
        <label
          htmlFor="video-upload"
          className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg cursor-pointer hover:bg-blue-700 transition-colors"
        >
          Upload Video
        </label>
        {processing && (
          <div className="text-white">
            <div>{stage}</div>
            <div className="w-48 h-2 bg-gray-700 rounded-full mt-1">
              <div
                className="h-full bg-blue-600 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}
        {error && (
          <div className="text-red-500">
            Error: {error}
          </div>
        )}
      </div>
    </div>
  );
};

export default HighPrecisionMovieTo3D;
