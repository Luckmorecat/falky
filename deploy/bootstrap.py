#!/usr/bin/env python3
"""Initial install uses the same transaction as an installed operator.

Run from a trusted source checkout or extracted, independently verified artifact.
The instance .env and external Docker network must already exist.
"""
from release import main

if __name__ == '__main__':
    main()
