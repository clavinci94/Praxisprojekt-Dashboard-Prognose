from fastapi import APIRouter

router = APIRouter(prefix="/version", tags=["version"])

@router.get("")
def version():
    return {"version": "0.1.0"}
