// Offline OCR via macOS's Vision framework. Invoked only by local-ocr.ts's
// execFile call with a fixed argv (swift <this script> <path>) — no shell,
// no argument beyond the one image path.
import Vision
import AppKit
import Foundation

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: ocr-macos.swift <image path>\n".data(using: .utf8)!)
    exit(2)
}

let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("could not decode image at \(path)\n".data(using: .utf8)!)
    exit(1)
}

let semaphore = DispatchSemaphore(value: 0)
var recognizedLines: [String] = []
var failure: String?

let request = VNRecognizeTextRequest { request, error in
    if let error = error {
        failure = error.localizedDescription
    } else if let observations = request.results as? [VNRecognizedTextObservation] {
        recognizedLines = observations.compactMap { $0.topCandidates(1).first?.string }
    }
    semaphore.signal()
}
request.recognitionLevel = .accurate

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("\(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}
semaphore.wait()

if let failure = failure {
    FileHandle.standardError.write("\(failure)\n".data(using: .utf8)!)
    exit(1)
}

print(recognizedLines.joined(separator: "\n"))
