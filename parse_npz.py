#!/usr/bin/env python3
"""
Parse NPZ file and extract QA metrics
Usage: python3 parse_npz.py <npz_file_path>
Returns: JSON string with QA metrics
"""
import sys
import numpy as np
import json

def parse_npz(filepath):
    try:
        npz = np.load(filepath, allow_pickle=True)

        # Extract arrays safely
        def get_array(key, default=None):
            return npz[key].tolist() if key in npz else default

        # Extract QA metrics
        left_confidence = get_array('left_confidence', [])
        right_confidence = get_array('right_confidence', [])
        left_tracked = get_array('left_tracked', [])
        right_tracked = get_array('right_tracked', [])
        both_hands_not_in_frame = get_array('both_hands_not_in_frame', [])
        hand_speed_exceeded = get_array('hand_speed_exceeded', [])
        tracking_errors = get_array('tracking_errors', [])

        n_frames = len(left_confidence) if left_confidence else 0

        # Parse metadata
        metadata = {}
        if 'metadata' in npz:
            metadata_bytes = npz['metadata'][0]
            if isinstance(metadata_bytes, bytes):
                metadata_str = metadata_bytes.decode('utf-8')
                metadata = json.loads(metadata_str)

        result = {
            'success': True,
            'n_frames': n_frames,
            'left_confidence': left_confidence,
            'right_confidence': right_confidence,
            'left_tracked': left_tracked,
            'right_tracked': right_tracked,
            'both_hands_not_in_frame': both_hands_not_in_frame,
            'hand_speed_exceeded': hand_speed_exceeded,
            'tracking_errors': tracking_errors,
            'metadata': metadata
        }

        npz.close()
        return result

    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'error_type': type(e).__name__
        }

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error': 'Missing file path argument'}))
        sys.exit(1)

    filepath = sys.argv[1]
    result = parse_npz(filepath)
    print(json.dumps(result))

    sys.exit(0 if result.get('success') else 1)
